/**
 * Endpoint and connection verification for the Telegram live connector (design section 19.8). It calls getMe,
 * getWebhookInfo and getBusinessConnection only, so it reads no messages. The report carries IDs, flags and counts:
 * never the token, a name, a webhook URL or message content.
 */
import type { Config } from '../../config.ts';
import { BotApiError, type BotApi, type BotUser, type BusinessConnection, type WebhookInfo } from './bot-api.ts';
import { telegramUpdateSchema } from './fixture-schema.ts';

export type VerificationCheckId =
  | 'token_accepted'
  | 'bot_can_connect_to_business'
  | 'polling_transport'
  | 'connection_enabled'
  | 'connection_owner_provisioned'
  | 'connection_rights_none'
  | 'approved_chats_configured'
  | 'approval_reference_configured';

export interface VerificationCheck {
  id: VerificationCheckId;
  passed: boolean;
  detail: string;
}

/** A business connection by IDs and flags only (no names). */
export interface ConnectionSummary {
  id: string;
  ownerUserId: string;
  enabled: boolean;
  rightsGranted: string[];
}

export interface VerificationReport {
  /** True only when every check passed. */
  ready: boolean;
  bot: { id: number; username: string | null; canConnectToBusiness: boolean } | null;
  webhook: { set: boolean; pendingUpdateCount: number; allowedUpdates: string[]; lastErrorAt: string | null; lastErrorMessage: string | null } | null;
  connection: ConnectionSummary | null;
  checks: VerificationCheck[];
}

export interface ConnectionDiscovery {
  /** The latest state of each business connection found in the pending updates. */
  connections: ConnectionSummary[];
  /** Pending updates that are not business_connection updates; counted, never read. */
  otherUpdates: number;
}

export interface VerifyOptions {
  /** externalAccountId of the provisioned live channel account (npm run telegram:provision), if any. */
  provisionedOwnerUserId?: string | null;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; detail: string };

const MS_PER_SECOND = 1_000;
/** Checks that need an accepted token; reported as not checked when getMe fails. */
const NEEDS_TOKEN: VerificationCheckId[] = [
  'bot_can_connect_to_business',
  'polling_transport',
  'connection_enabled',
  'connection_owner_provisioned',
  'connection_rights_none',
];

const check = (id: VerificationCheckId, passed: boolean, detail: string): VerificationCheck => ({ id, passed, detail });

function describeError(error: BotApiError): string {
  const status = error.status === null ? '' : ` ${error.status}`;
  const description = error.description === null ? '' : `: ${error.description}`;
  return `${error.method} ${error.code}${status}${description}`;
}

async function attempt<T>(call: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (!(error instanceof BotApiError)) throw error;
    return { ok: false, detail: describeError(error) };
  }
}

function grantedRights(connection: BusinessConnection): string[] {
  return Object.entries(connection.rights ?? {})
    .filter(([, granted]) => granted)
    .map(([right]) => right)
    .sort();
}

function summarize(connection: BusinessConnection): ConnectionSummary {
  return { id: connection.id, ownerUserId: String(connection.user.id), enabled: connection.is_enabled, rightsGranted: grantedRights(connection) };
}

function botChecks(bot: BotUser): VerificationCheck[] {
  const business = bot.can_connect_to_business === true;
  return [
    check('token_accepted', true, `bot ${bot.id}${bot.username ? ` (@${bot.username})` : ''}`),
    check('bot_can_connect_to_business', business, business ? 'business mode is on' : 'business mode is off: turn it on for the bot in BotFather'),
  ];
}

function webhookCheck(webhook: Attempt<WebhookInfo>): VerificationCheck {
  if (!webhook.ok) return check('polling_transport', false, webhook.detail);
  return webhook.value.url === ''
    ? check('polling_transport', true, 'no webhook is set, so long polling can be used')
    : check('polling_transport', false, 'a webhook is set; long polling cannot be used while it is');
}

function ownerCheck(owner: string, provisioned: string | null): VerificationCheck {
  if (provisioned === null) {
    return check('connection_owner_provisioned', false, `owner user ${owner} has no provisioned live channel account (npm run telegram:provision)`);
  }
  return provisioned === owner
    ? check('connection_owner_provisioned', true, `owner user ${owner} is the provisioned live channel account`)
    : check('connection_owner_provisioned', false, `owner user ${owner} is not the provisioned live channel account ${provisioned}`);
}

function connectionChecks(connection: Attempt<BusinessConnection> | null, provisioned: string | null): VerificationCheck[] {
  const unread = connection === null ? 'TELEGRAM_APPROVED_CONNECTION_ID is not set' : connection.ok ? null : connection.detail;
  if (unread !== null || connection === null || !connection.ok) {
    const skipped = 'not checked: the approved connection could not be read';
    return [
      check('connection_enabled', false, unread ?? skipped),
      check('connection_owner_provisioned', false, skipped),
      check('connection_rights_none', false, skipped),
    ];
  }
  const rights = grantedRights(connection.value);
  const enabled = connection.value.is_enabled;
  return [
    check('connection_enabled', enabled, enabled ? 'the approved connection is enabled' : 'the approved connection is disabled'),
    ownerCheck(String(connection.value.user.id), provisioned),
    check('connection_rights_none', rights.length === 0, rights.length === 0 ? 'no rights granted (read-only intake)' : `rights granted: ${rights.join(', ')}`),
  ];
}

function configChecks(telegram: Config['telegram']): VerificationCheck[] {
  const chats = telegram.approvedChatIds.length;
  return [
    check('approved_chats_configured', chats > 0, chats > 0 ? `${chats} approved chat IDs` : 'TELEGRAM_APPROVED_CHAT_IDS is not set'),
    check(
      'approval_reference_configured',
      telegram.approvalReference !== null,
      telegram.approvalReference !== null ? 'an approval reference is set' : 'TELEGRAM_APPROVAL_REFERENCE is not set',
    ),
  ];
}

function finish(parts: Omit<VerificationReport, 'ready'>): VerificationReport {
  return { ready: parts.checks.every((c) => c.passed), ...parts };
}

export async function verifyConnection(api: BotApi, config: Pick<Config, 'telegram'>, options: VerifyOptions = {}): Promise<VerificationReport> {
  const { telegram } = config;
  const bot = await attempt(() => api.getMe());
  if (!bot.ok) {
    const skipped = NEEDS_TOKEN.map((id) => check(id, false, 'not checked: the token was not accepted'));
    return finish({ bot: null, webhook: null, connection: null, checks: [check('token_accepted', false, bot.detail), ...skipped, ...configChecks(telegram)] });
  }
  const webhook = await attempt(() => api.getWebhookInfo());
  const connectionId = telegram.approvedConnectionId;
  const connection = connectionId === null ? null : await attempt(() => api.getBusinessConnection(connectionId));
  const info = webhook.ok ? webhook.value : null;
  const linked = connection?.ok ? connection.value : null;
  return finish({
    bot: { id: bot.value.id, username: bot.value.username ?? null, canConnectToBusiness: bot.value.can_connect_to_business === true },
    webhook: info && {
      set: info.url !== '',
      pendingUpdateCount: info.pending_update_count,
      allowedUpdates: info.allowed_updates ?? [],
      lastErrorAt: info.last_error_date === undefined ? null : new Date(info.last_error_date * MS_PER_SECOND).toISOString(),
      lastErrorMessage: info.last_error_message ?? null,
    },
    connection: linked && summarize(linked),
    checks: [...botChecks(bot.value), webhookCheck(webhook), ...connectionChecks(connection, options.provisionedOwnerUserId ?? null), ...configChecks(telegram)],
  });
}

/**
 * Finds the business connection ID and owner user ID before the connector is set up: one short poll asking for
 * business_connection updates, with no offset, so no queued update is confirmed and the connector receives those later.
 * Updates of other kinds that were already queued are counted and never read. Telegram keeps the narrowed
 * allowed_updates until the next poll (the connector's first), so message updates created in between are never queued.
 */
export async function discoverConnections(api: BotApi): Promise<ConnectionDiscovery> {
  const updates = await api.getUpdates({ timeoutSeconds: 0, allowedUpdates: ['business_connection'] });
  const latest = new Map<string, ConnectionSummary>();
  let otherUpdates = 0;
  for (const raw of updates) {
    const parsed = telegramUpdateSchema.safeParse(raw);
    const connection = parsed.success ? parsed.data.business_connection : undefined;
    if (connection) latest.set(connection.id, summarize(connection));
    else otherUpdates += 1;
  }
  return { connections: [...latest.values()], otherUpdates };
}
