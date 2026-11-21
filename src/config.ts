/** Configuration from environment variables (design section 15). Rejects anything that is not loopback. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTOR_CAPTURE_METHODS,
  REVIEWER_KINDS,
  type ConnectorCaptureMethod,
  type ReviewerKind,
} from './contract/enums.ts';
import { DEFAULT_CONTROLLED_TEST_RECORD, hasValidControlledTestRecord } from './contract/controlled-test-record.ts';

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;
const LOOPBACK_URL_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
const MAX_PORT = 65_535;
/** Relative MIRSAD_CONTROLLED_TEST_RECORD paths resolve against the project root, not the working directory. */
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  demoSeed: boolean;
  reviewer: ReviewerKind;
  lmStudio: { baseUrl: string; model: string; contextTokens: number; timeoutMs: number };
  reviewConcurrency: number;
  reviewAllowedCaptureMethods: ConnectorCaptureMethod[];
  streamRetention: number;
  rateLimitPerMinute: number;
  whatsappImportEnabled: boolean;
  /** Absolute path of the Telegram controlled-test record that opens the WhatsApp gate. */
  controlledTestRecordPath: string;
  telegram: {
    liveEnabled: boolean;
    botToken: string | null;
    approvedConnectionId: string | null;
    approvedChatIds: string[];
    approvalReference: string | null;
  };
}

export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, problem: string) {
    super(`${variable}: ${problem}`);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}

type Env = Record<string, string | undefined>;

function value(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

function int(env: Env, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || parsed < min || parsed > max) {
    throw new ConfigError(name, `must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(name, 'must be true or false');
}

function list(env: Env, name: string): string[] {
  const raw = value(env, name);
  return raw === undefined ? [] : raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = value(env, name) ?? fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new ConfigError(name, `must be one of ${allowed.join(', ')}`);
  return raw as T;
}

function loopbackUrl(env: Env, name: string, fallback: string): string {
  const raw = value(env, name) ?? fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(name, 'must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_URL_HOSTNAMES.includes(url.hostname)) {
    throw new ConfigError(name, 'must be an http(s) URL on a loopback host');
  }
  return raw.replace(/\/+$/, '');
}

function reviewMethods(env: Env): ConnectorCaptureMethod[] {
  const name = 'MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS';
  const raw = value(env, name) === undefined ? ['fixture_replay'] : list(env, name);
  for (const method of raw) {
    const known = (CONNECTOR_CAPTURE_METHODS as readonly string[]).includes(method);
    if (!known || method === 'telegram_business_live') {
      throw new ConfigError(name, `capture method ${method} cannot be reviewed`);
    }
  }
  return raw as ConnectorCaptureMethod[];
}

function controlledTestRecordPath(env: Env): string {
  const raw = value(env, 'MIRSAD_CONTROLLED_TEST_RECORD') ?? DEFAULT_CONTROLLED_TEST_RECORD;
  return path.resolve(PROJECT_ROOT, raw);
}

export function loadConfig(env: Env): Config {
  const host = value(env, 'MIRSAD_HOST') ?? '127.0.0.1';
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(host)) {
    throw new ConfigError('MIRSAD_HOST', `must be one of ${LOOPBACK_HOSTS.join(', ')}`);
  }
  const whatsappImportEnabled = bool(env, 'MIRSAD_WHATSAPP_IMPORT_ENABLED', false);
  const recordPath = controlledTestRecordPath(env);
  const approvalReference = value(env, 'TELEGRAM_APPROVAL_REFERENCE');
  if (whatsappImportEnabled && !hasValidControlledTestRecord(recordPath, approvalReference)) {
    throw new ConfigError('MIRSAD_WHATSAPP_IMPORT_ENABLED', 'requires a verified Telegram controlled-test record');
  }
  return {
    host,
    port: int(env, 'MIRSAD_PORT', 8787, 0, MAX_PORT),
    dataDir: path.resolve(value(env, 'MIRSAD_DATA_DIR') ?? './data'),
    demoSeed: bool(env, 'MIRSAD_DEMO_SEED', true),
    reviewer: oneOf(env, 'MIRSAD_REVIEWER', REVIEWER_KINDS, 'lmstudio'),
    lmStudio: {
      baseUrl: loopbackUrl(env, 'MIRSAD_LMSTUDIO_BASE_URL', 'http://127.0.0.1:1234/v1'),
      model: value(env, 'MIRSAD_LMSTUDIO_MODEL') ?? 'qwen3.5-9b',
      contextTokens: int(env, 'MIRSAD_LMSTUDIO_CONTEXT_TOKENS', 4096, 512),
      timeoutMs: int(env, 'MIRSAD_LMSTUDIO_TIMEOUT_MS', 120_000, 1),
    },
    reviewConcurrency: int(env, 'MIRSAD_REVIEW_CONCURRENCY', 2, 1, 64),
    reviewAllowedCaptureMethods: reviewMethods(env),
    streamRetention: int(env, 'MIRSAD_STREAM_RETENTION', 5000, 1),
    rateLimitPerMinute: int(env, 'MIRSAD_RATE_LIMIT_PER_MINUTE', 600, 1),
    whatsappImportEnabled,
    controlledTestRecordPath: recordPath,
    telegram: {
      liveEnabled: bool(env, 'TELEGRAM_LIVE_ENABLED', false),
      botToken: value(env, 'TELEGRAM_BOT_TOKEN') ?? null,
      approvedConnectionId: value(env, 'TELEGRAM_APPROVED_CONNECTION_ID') ?? null,
      approvedChatIds: list(env, 'TELEGRAM_APPROVED_CHAT_IDS'),
      approvalReference: value(env, 'TELEGRAM_APPROVAL_REFERENCE') ?? null,
    },
  };
}
