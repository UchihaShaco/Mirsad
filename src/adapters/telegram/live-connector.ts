/**
 * Telegram live connector (design section 13): long-polls the Bot API for business updates and stores only those for
 * the approved connection and chats, through the same intake function as every other connector. Everything else is
 * dropped before storage and only counted. It refuses to start unless every gate is set, and it has no way to send
 * anything. Its principal's capture method is telegram_business_live, so its content is never reviewed (section 10).
 */
import type { Config } from '../../config.ts';
import { AppError } from '../../contract/errors.ts';
import { IngestRequest, type IngestResult, type IntakeEnvelope } from '../../contract/schemas.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Principal } from '../../ports/identity.ts';
import { ingest } from '../../services/intake.ts';
import type { Db, Tx } from '../../storage/db.ts';
import { findChannelAccountById, grantedAccountIds, toPrincipal } from '../../storage/repos/principals.ts';
import type { ChannelAccountRow, PrincipalRow } from '../../storage/rows.ts';
import { BotApiError, BUSINESS_UPDATE_TYPES, createBotApi, isWellFormedBotToken, type BotApi, type RawUpdate } from './bot-api.ts';
import { telegramUpdateSchema } from './fixture-schema.ts';
import { createTelegramAdapter } from './normalize.ts';
import type { TelegramBusinessConnection, TelegramUpdate } from './types.ts';

/** What each gate is called in a refusal: the environment variable, or the provisioned connector principal. */
export const LIVE_GATES = {
  enabled: 'TELEGRAM_LIVE_ENABLED',
  token: 'TELEGRAM_BOT_TOKEN',
  connection: 'TELEGRAM_APPROVED_CONNECTION_ID',
  chats: 'TELEGRAM_APPROVED_CHAT_IDS',
  approval: 'TELEGRAM_APPROVAL_REFERENCE',
  principal: 'live connector principal',
} as const;

/** Seconds Telegram is asked to hold each getUpdates call open. */
const POLL_TIMEOUT_SECONDS = 30;
/** connector_state key holding the next update_id to ask for. */
const OFFSET_STATE_KEY = 'telegram_update_offset';
/**
 * Telegram keeps an unconfirmed update for at most 24 hours. An offset committed longer ago than that can only confirm
 * updates Telegram no longer holds, and after a week without updates Telegram numbers new updates from a random value,
 * possibly below the offset, so polling with it would confirm, and so lose, every new update. Such an offset is stale:
 * the connector polls without one, and intake's deduplication absorbs anything delivered again.
 */
const UPDATE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
/** Telegram's answers to a wrong or revoked token; retrying cannot help. */
const TOKEN_REJECTED_STATUSES: readonly number[] = [401, 404];
/** A Telegram user ID: the owner account's `externalAccountId` (design section 19.8). */
const TELEGRAM_USER_ID = /^[1-9]\d{0,15}$/;
const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/;

/** start() refused: `missing` names every gate that is not set (or not valid), never a value. */
export class LiveConnectorGateError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Telegram live connector refused to start; not set or not valid: ${missing.join(', ')}`);
    this.name = 'LiveConnectorGateError';
    this.missing = missing;
  }
}

/** The provisioned live connector principal and the owner's channel account it is granted on. */
export interface LiveBinding {
  principal: Principal;
  account: ChannelAccountRow;
  ownerUserId: number;
}

/**
 * Why intake stopped: stop() was called; Telegram rejected the token; or a business_connection update showed the
 * approved connection disabled, replaced by a new connection ID for the same owner, or owned by someone other than
 * the provisioned account.
 */
export type LiveStopReason = 'stopped' | 'token_rejected' | 'connection_disabled' | 'connection_changed' | 'connection_owner_mismatch';
type DropReason = 'otherConnection' | 'otherChat' | 'other';

export interface LiveConnectorStats {
  running: boolean;
  stoppedReason: LiveStopReason | null;
  /** The next update_id to ask for; null before the first update. */
  offset: number | null;
  /** Intake events newly recorded. */
  stored: number;
  /** Intake events Mirsad already had (redelivered updates). */
  duplicates: number;
  /** Intake events refused by validation or intake. */
  rejected: number;
  /** Updates dropped before storage: another connection, a chat not on the approved list, or not a business message. */
  dropped: Record<DropReason, number>;
}

export interface LiveConnector {
  /** Throws LiveConnectorGateError, and does nothing else, unless every gate is set. */
  start(): void;
  stop(): Promise<void>;
  stats(): LiveConnectorStats;
}

export interface LiveConnectorDeps {
  config: Pick<Config, 'telegram' | 'whatsappImportEnabled' | 'reviewAllowedCaptureMethods'>;
  db: Db;
  logger: Logger;
  /** Defaults to the real Bot API with the configured token. */
  botApi?: BotApi;
  /** Base delay before a failed poll is retried. */
  retryDelayMs?: number;
  /** Called after a commit that stored new events, so the capture and review workers can be woken. */
  onEvidenceStored?: () => void;
}

interface ApprovedScope {
  token: string;
  connectionId: string;
  chatIds: ReadonlySet<string>;
}

/** The offset to poll from: null when none is stored or the stored one is stale (`stale` says which). */
interface UsableOffset {
  offset: number | null;
  stale: boolean;
}

interface Session {
  api: BotApi;
  binding: LiveBinding;
  scope: ApprovedScope;
  adapter: ReturnType<typeof createTelegramAdapter>;
  stored: UsableOffset;
}

/** The stored offset, judged by the time of its last commit (`updated_at`) against the database clock. */
function readOffset(tx: Tx, connectorId: string): UsableOffset {
  const row = tx.get<{ value: string; updated_at: string }>(
    'SELECT value, updated_at FROM connector_state WHERE connector_id = :connectorId AND key = :key',
    { connectorId, key: OFFSET_STATE_KEY },
  );
  const offset = row === undefined ? Number.NaN : Number(row.value);
  if (row === undefined || !Number.isSafeInteger(offset)) return { offset: null, stale: false };
  const stale = Date.parse(tx.now()) - Date.parse(row.updated_at) > UPDATE_RETENTION_MS;
  return stale ? { offset: null, stale } : { offset, stale };
}

function writeOffset(tx: Tx, connectorId: string, offset: number): void {
  tx.run(
    `INSERT INTO connector_state (connector_id, key, value, updated_at) VALUES (:connectorId, :key, :value, :at)
     ON CONFLICT (connector_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { connectorId, key: OFFSET_STATE_KEY, value: String(offset), at: tx.now() },
  );
}

/** Non-disabled telegram_business_live connectors with a grant on a Telegram account named by an owner user ID. */
export function findLiveBindings(tx: Tx): LiveBinding[] {
  const connectors = tx.all<PrincipalRow>(
    `SELECT * FROM principals WHERE kind = 'connector' AND capture_method = 'telegram_business_live' AND disabled = 0
     ORDER BY created_at, id`,
  );
  return connectors.flatMap((row) =>
    grantedAccountIds(tx, row.id)
      .map((accountId) => findChannelAccountById(tx, accountId))
      .filter((a): a is ChannelAccountRow => a !== undefined && a.source === 'telegram' && a.workspace_id === row.workspace_id)
      .filter((a) => TELEGRAM_USER_ID.test(a.external_account_id) && Number.isSafeInteger(Number(a.external_account_id)))
      .map((account) => ({ principal: toPrincipal(row), account, ownerUserId: Number(account.external_account_id) })),
  );
}

function approvedScope(telegram: Config['telegram']): { scope: ApprovedScope | null; missing: string[] } {
  const chatsValid = telegram.approvedChatIds.length > 0 && telegram.approvedChatIds.every((id) => TELEGRAM_CHAT_ID.test(id));
  const gates: (string | null)[] = [
    telegram.liveEnabled ? null : LIVE_GATES.enabled,
    telegram.botToken && isWellFormedBotToken(telegram.botToken) ? null : LIVE_GATES.token,
    telegram.approvedConnectionId ? null : LIVE_GATES.connection,
    chatsValid ? null : LIVE_GATES.chats,
    telegram.approvalReference ? null : LIVE_GATES.approval,
  ];
  const missing = gates.filter((gate): gate is string => gate !== null);
  if (missing.length > 0 || !telegram.botToken || !telegram.approvedConnectionId) return { scope: null, missing };
  return {
    scope: { token: telegram.botToken, connectionId: telegram.approvedConnectionId, chatIds: new Set(telegram.approvedChatIds) },
    missing,
  };
}

/** Checks every gate; throws LiveConnectorGateError naming each one that is missing. */
function openSession(deps: LiveConnectorDeps): Session {
  const { scope, missing } = approvedScope(deps.config.telegram);
  const bindings = deps.db.transaction((tx) => findLiveBindings(tx));
  const problems = bindings.length === 1 ? missing : [...missing, LIVE_GATES.principal];
  const [binding] = bindings;
  if (problems.length > 0 || !scope || !binding) throw new LiveConnectorGateError(problems);
  const adapter = createTelegramAdapter({
    businessUserId: binding.ownerUserId,
    businessConnectionId: scope.connectionId,
    externalAccountId: binding.account.external_account_id,
  });
  const stored = deps.db.transaction((tx) => readOffset(tx, binding.principal.id));
  return { api: deps.botApi ?? createBotApi({ token: scope.token }), binding, scope, adapter, stored };
}

type Decision =
  | { kind: 'ingest' }
  | { kind: 'drop'; reason: DropReason }
  | { kind: 'connection_unchanged' }
  | { kind: 'stop'; reason: LiveStopReason };

/** Pure: what a business_connection update means for the approved connection of the provisioned owner. */
function classifyConnection(connection: TelegramBusinessConnection, scope: ApprovedScope, ownerUserId: number): Decision {
  const ownerMatches = connection.user.id === ownerUserId;
  if (connection.id === scope.connectionId) {
    if (!ownerMatches) return { kind: 'stop', reason: 'connection_owner_mismatch' };
    return connection.is_enabled ? { kind: 'connection_unchanged' } : { kind: 'stop', reason: 'connection_disabled' };
  }
  return ownerMatches ? { kind: 'stop', reason: 'connection_changed' } : { kind: 'drop', reason: 'otherConnection' };
}

/** Pure: whether an update belongs to the approved connection and chats. */
function classify(update: TelegramUpdate, scope: ApprovedScope, ownerUserId: number): Decision {
  if (update.business_connection) return classifyConnection(update.business_connection, scope, ownerUserId);
  const message = update.business_message ?? update.edited_business_message;
  const removed = update.deleted_business_messages;
  const connectionId = message?.business_connection_id ?? removed?.business_connection_id;
  const chatId = message?.chat.id ?? removed?.chat.id;
  if (connectionId === undefined || chatId === undefined) return { kind: 'drop', reason: 'other' };
  if (connectionId !== scope.connectionId) return { kind: 'drop', reason: 'otherConnection' };
  if (!scope.chatIds.has(String(chatId))) return { kind: 'drop', reason: 'otherChat' };
  return { kind: 'ingest' };
}

const retryDelay = (baseMs: number, attempt: number): number => Math.min(baseMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);

const isTokenRejected = (error: unknown): boolean =>
  error instanceof BotApiError && error.status !== null && TOKEN_REJECTED_STATUSES.includes(error.status);

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

const emptyStats = (): LiveConnectorStats => ({
  running: false,
  stoppedReason: null,
  offset: null,
  stored: 0,
  duplicates: 0,
  rejected: 0,
  dropped: { otherConnection: 0, otherChat: 0, other: 0 },
});

const droppedTotal = (s: LiveConnectorStats): number => s.dropped.otherConnection + s.dropped.otherChat + s.dropped.other;

/** One connector: start() opens a polling session after the gates pass; stop() or a stop reason ends it. */
class TelegramLiveConnector implements LiveConnector {
  private readonly deps: LiveConnectorDeps;
  private state = emptyStats();
  private controller: AbortController | null = null;
  private loop: Promise<void> = Promise.resolve();

  constructor(deps: LiveConnectorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.state.running) return;
    const session = openSession(this.deps);
    this.controller = new AbortController();
    this.state = { ...this.state, running: true, stoppedReason: null, offset: session.stored.offset };
    this.deps.logger.info('telegram_live_connector_started', { principalId: session.binding.principal.id });
    if (session.stored.stale) this.logStaleOffset(session);
    this.loop = this.poll(session, this.controller.signal);
  }

  async stop(): Promise<void> {
    this.halt('stopped');
    await this.loop;
  }

  stats(): LiveConnectorStats {
    return structuredClone(this.state);
  }

  private halt(reason: LiveStopReason): void {
    if (!this.state.running) return;
    this.state = { ...this.state, running: false, stoppedReason: reason };
    this.controller?.abort();
    if (reason === 'stopped') this.deps.logger.info('telegram_live_connector_stopped', { reason });
    else this.deps.logger.warn('telegram_live_connector_stopped', { reason });
  }

  private logStaleOffset(session: Session): void {
    this.deps.logger.info('telegram_live_offset_stale', { principalId: session.binding.principal.id });
  }

  /**
   * The offset for the next getUpdates call. Once its last commit is older than Telegram keeps updates, it is dropped
   * and the connector polls without one (see UPDATE_RETENTION_MS).
   */
  private pollOffset(session: Session): number | undefined {
    if (this.state.offset === null) return undefined;
    const { stale } = this.deps.db.transaction((tx) => readOffset(tx, session.binding.principal.id));
    if (!stale) return this.state.offset;
    this.state = { ...this.state, offset: null };
    this.logStaleOffset(session);
    return undefined;
  }

  /** Stores the offset past this update in the caller's transaction; never moves it backwards. */
  private commitOffset(session: Session, tx: Tx, updateId: number): number {
    const offset = Math.max(this.state.offset ?? 0, updateId + 1);
    writeOffset(tx, session.binding.principal.id, offset);
    return offset;
  }

  /** Confirms an update that stores nothing. */
  private skip(session: Session, updateId: number): void {
    const offset = this.deps.db.transaction((tx) => this.commitOffset(session, tx, updateId));
    this.state = { ...this.state, offset };
  }

  private drop(session: Session, reason: DropReason, updateId: number): void {
    this.skip(session, updateId);
    this.state = { ...this.state, dropped: { ...this.state.dropped, [reason]: this.state.dropped[reason] + 1 } };
  }

  private ingestEnvelope(session: Session, tx: Tx, envelope: IntakeEnvelope): IngestResult {
    const parsed = IngestRequest.safeParse(envelope);
    if (!parsed.success) throw AppError.of('validation_failed', 'The normalized update is not a valid intake event.');
    const { event, ...target } = parsed.data;
    return ingest(tx, session.binding.principal, target, event, this.deps.config);
  }

  /** The update's events and its offset commit together, so a crash in between can only cause a redelivery. */
  private ingestUpdate(session: Session, update: TelegramUpdate): void {
    const envelopes = session.adapter.normalize(update);
    if (envelopes.length === 0) return this.drop(session, 'other', update.update_id);
    try {
      const { results, offset } = this.deps.db.transaction((tx) => ({
        results: envelopes.map((e) => this.ingestEnvelope(session, tx, e)),
        offset: this.commitOffset(session, tx, update.update_id),
      }));
      const stored = results.filter((r) => r.messageEventId !== null).length;
      const { state } = this;
      this.state = { ...state, offset, stored: state.stored + stored, duplicates: state.duplicates + results.length - stored };
      if (stored > 0) this.deps.onEvidenceStored?.();
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const offset = this.deps.db.transaction((tx) => this.commitOffset(session, tx, update.update_id));
      this.state = { ...this.state, offset, rejected: this.state.rejected + envelopes.length };
      this.deps.logger.warn('telegram_live_update_rejected', { code: error.code });
    }
  }

  private processUpdate(session: Session, raw: RawUpdate): void {
    const parsed = telegramUpdateSchema.safeParse(raw);
    if (!parsed.success) return this.drop(session, 'other', raw.update_id);
    const update = parsed.data as TelegramUpdate;
    const decision = classify(update, session.scope, session.binding.ownerUserId);
    if (decision.kind === 'ingest') return this.ingestUpdate(session, update);
    if (decision.kind === 'drop') return this.drop(session, decision.reason, update.update_id);
    this.skip(session, update.update_id);
    // Later updates stay unconfirmed, so Telegram keeps them until intake is approved again.
    if (decision.kind === 'stop') this.halt(decision.reason);
  }

  private processBatch(session: Session, updates: RawUpdate[]): void {
    if (updates.length === 0) return;
    const before = this.state;
    for (const raw of updates) {
      if (!this.state.running) break;
      this.processUpdate(session, raw);
    }
    const after = this.state;
    this.deps.logger.info('telegram_live_batch', {
      updates: updates.length,
      stored: after.stored - before.stored,
      duplicates: after.duplicates - before.duplicates,
      rejected: after.rejected - before.rejected,
      dropped: droppedTotal(after) - droppedTotal(before),
    });
  }

  /** Codes and counts only: a Bot API failure by code and status, anything else by error class. */
  private logPollFailure(error: unknown, attempt: number): void {
    if (error instanceof BotApiError) {
      this.deps.logger.warn('telegram_live_poll_failed', { code: error.code, status: error.status, attempt });
      return;
    }
    const errorClass = error instanceof Error ? error.name : 'unknown';
    this.deps.logger.error('telegram_live_poll_failed', { code: 'processing_failed', errorClass, attempt });
  }

  private async poll(session: Session, signal: AbortSignal): Promise<void> {
    const baseDelayMs = this.deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    let failures = 0;
    while (this.state.running) {
      try {
        const offset = this.pollOffset(session);
        const updates = await session.api.getUpdates(
          { ...(offset === undefined ? {} : { offset }), timeoutSeconds: POLL_TIMEOUT_SECONDS, allowedUpdates: BUSINESS_UPDATE_TYPES },
          signal,
        );
        failures = 0;
        this.processBatch(session, updates);
      } catch (error) {
        if (!this.state.running) return;
        if (isTokenRejected(error)) return this.halt('token_rejected');
        failures += 1;
        this.logPollFailure(error, failures);
        await abortableDelay(retryDelay(baseDelayMs, failures), signal);
      }
    }
  }
}

export function createLiveConnector(deps: LiveConnectorDeps): LiveConnector {
  return new TelegramLiveConnector(deps);
}
