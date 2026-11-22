/**
 * GET /v1/status (design section 13): service, storage, worker queues, reviewer, and the channel states. Telegram
 * readiness comes from the readiness file written by `npm run telegram:readiness`, and `controlled_test_verified`
 * only from a controlled-test record that validates and documents a verified test (the same check as the WhatsApp
 * gate). Nothing here reads message content.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { hasValidControlledTestRecord, readControlledTestRecord } from '../contract/controlled-test-record.ts';
import type { Status } from '../contract/schemas.ts';
import type { Reviewer, ReviewerHealth } from '../ports/reviewer.ts';
import type { Db, Tx } from '../storage/db.ts';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Where `npm run telegram:readiness` writes its record. */
export const DEFAULT_READINESS_FILE = path.join(PROJECT_ROOT, 'docs', 'telegram', 'readiness.json');
/** The local evidence store's folder under the data directory (design section 9). */
const EVIDENCE_DIRECTORY = 'evidence';
/** Longest wait for the reviewer's health answer before it is reported unreachable. */
const HEALTH_TIMEOUT_MS = 2_000;
const SERVICE_VERSION = z
  .object({ version: z.string() })
  .parse(JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'))).version;

/** The eight local checks of design section 13, in the order the readiness run performs them. */
export const READINESS_CHECK_IDS = [
  'inbound_first_new_inbound',
  'officer_first_both_directions',
  'capture_per_message',
  'edit_delete_separate_events',
  'redelivery_creates_nothing',
  'outgoing_labelled_outgoing',
  'takeover_simulated_send',
  'live_connector_gated',
] as const;
export type ReadinessCheckId = (typeof READINESS_CHECK_IDS)[number];

/** docs/telegram/readiness.json: IDs, results and counts only. */
export const ReadinessRecord = z.object({
  state: z.enum(['ready_for_controlled_test', 'not_ready']),
  recordedAt: z.iso.datetime(),
  checks: z.array(z.object({ id: z.string(), title: z.string(), passed: z.boolean(), detail: z.string() })),
});
export type ReadinessRecord = z.infer<typeof ReadinessRecord>;

export const WHATSAPP_GATES = {
  closed: 'closed_until_telegram_controlled_test_verified',
  importDisabled: 'closed_until_import_enabled',
  open: 'open',
} as const;

export interface StatusDeps {
  config: Config;
  db: Db;
  reviewer: Reviewer;
  startedAt: string;
  /** True only while the Telegram live connector is polling. */
  liveConnectorRunning: boolean;
  /** Defaults to DEFAULT_READINESS_FILE. */
  readinessFile?: string;
}

type TelegramStatus = Status['channels']['telegram'];

/** The record at `file`, or null when it is missing, is not JSON or does not match the schema. */
export function readReadinessRecord(file: string): ReadinessRecord | null {
  try {
    const parsed = ReadinessRecord.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Ready only when the record says so and every one of the eight checks is present and passed. */
export function isReadyForControlledTest(record: ReadinessRecord): boolean {
  return (
    record.state === 'ready_for_controlled_test' &&
    record.checks.every((c) => c.passed) &&
    READINESS_CHECK_IDS.every((id) => record.checks.some((c) => c.id === id))
  );
}

function hasVerifiedRecord(config: Config): boolean {
  return hasValidControlledTestRecord(config.controlledTestRecordPath, config.telegram.approvalReference ?? undefined);
}

function readiness(config: Config, readinessFile: string): Pick<TelegramStatus, 'readiness' | 'readinessRecordedAt'> {
  const record = hasVerifiedRecord(config) ? readControlledTestRecord(config.controlledTestRecordPath) : null;
  if (record) return { readiness: 'controlled_test_verified', readinessRecordedAt: `${record.testDate}T00:00:00.000Z` };
  const local = readReadinessRecord(readinessFile);
  if (local && isReadyForControlledTest(local)) return { readiness: 'ready_for_controlled_test', readinessRecordedAt: local.recordedAt };
  return { readiness: 'not_assessed', readinessRecordedAt: null };
}

function whatsappGate(config: Config): string {
  if (config.whatsappImportEnabled) return WHATSAPP_GATES.open;
  return hasVerifiedRecord(config) ? WHATSAPP_GATES.importDisabled : WHATSAPP_GATES.closed;
}

function workerCounts(tx: Tx): Status['workers'] {
  const row = tx.get<Record<'capturePending' | 'captureFailed' | 'reviewPending' | 'reviewRunning' | 'reviewUnavailable', number>>(
    `SELECT
       (SELECT COUNT(*) FROM captures WHERE status IN ('pending', 'rendering')) AS capturePending,
       (SELECT COUNT(*) FROM captures WHERE status = 'failed') AS captureFailed,
       (SELECT COUNT(*) FROM reviews WHERE status = 'pending') AS reviewPending,
       (SELECT COUNT(*) FROM reviews WHERE status = 'running') AS reviewRunning,
       (SELECT COUNT(*) FROM reviews WHERE status = 'unavailable') AS reviewUnavailable`,
  );
  return {
    capture: { pending: row?.capturePending ?? 0, failed: row?.captureFailed ?? 0 },
    review: { pending: row?.reviewPending ?? 0, running: row?.reviewRunning ?? 0, unavailable: row?.reviewUnavailable ?? 0 },
  };
}

/** `ok`; `not_created` until the first capture is written; `unavailable` when it is not a writable directory. */
function evidenceDirectoryState(dataDir: string): string {
  const dir = path.join(dataDir, EVIDENCE_DIRECTORY);
  try {
    if (!fs.statSync(dir).isDirectory()) return 'unavailable';
    fs.accessSync(dir, fs.constants.W_OK);
    return 'ok';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_created' : 'unavailable';
  }
}

async function reviewerHealth(reviewer: Reviewer): Promise<ReviewerHealth> {
  const unreachable: ReviewerHealth = { reachable: false, modelId: null };
  if (!reviewer.health) return unreachable;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ReviewerHealth>((resolve) => {
    timer = setTimeout(() => resolve(unreachable), HEALTH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([reviewer.health().catch(() => unreachable), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readStatus(deps: StatusDeps): Promise<Status> {
  const { config } = deps;
  const workers = deps.db.transaction((tx) => workerCounts(tx));
  const health = await reviewerHealth(deps.reviewer);
  return {
    service: { version: SERVICE_VERSION, startedAt: deps.startedAt },
    storage: { database: 'ok', evidenceDirectory: evidenceDirectoryState(config.dataDir) },
    workers,
    reviewer: {
      kind: config.reviewer,
      modelId: health.modelId ?? (config.reviewer === 'lmstudio' ? config.lmStudio.model : null),
      reachable: health.reachable,
    },
    channels: {
      telegram: {
        fixtureReplay: 'available',
        liveConnector: deps.liveConnectorRunning ? 'enabled' : 'disabled',
        ...readiness(config, deps.readinessFile ?? DEFAULT_READINESS_FILE),
      },
      whatsapp: { status: 'not_started', gate: whatsappGate(config) },
    },
  };
}
