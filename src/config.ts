/**
 * The service and LM Studio bind to loopback. Telegram replies can opt in to a fixed OpenRouter endpoint, and flagged
 * numbers to the contact-sync server on this machine (mirsad-contact-sync/).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTOR_CAPTURE_METHODS,
  REVIEWER_KINDS,
  type ConnectorCaptureMethod,
  type ReviewerKind,
} from './contract/enums.ts';
import { DEFAULT_CONTROLLED_TEST_RECORD } from './contract/controlled-test-record.ts';
import { GEMINI_REPLY_MODEL, OPENROUTER_REPLY_MODELS, type OpenRouterReplyModel } from './replies/openrouter-reply-generator.ts';

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;
/**
 * Which Telegram chats the live connector stores and the reply worker answers (design section 13): only the approved
 * list, or every private chat of the connected account (the owner's decision, with its own reference).
 */
export const TELEGRAM_CHAT_SCOPES = ['approved', 'all_private'] as const;
export type TelegramChatScope = (typeof TELEGRAM_CHAT_SCOPES)[number];
const LOOPBACK_URL_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
/** A label or source the contact-sync server stores beside each number: short, printable text. */
const SYNC_TEXT = /^[\p{L}\p{N} ._:()-]{1,64}$/u;
const MAX_PORT = 65_535;
/** Relative MIRSAD_CONTROLLED_TEST_RECORD paths resolve against the project root, not the working directory. */
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  demoSeed: boolean;
  reviewer: ReviewerKind;
  replyProvider: { kind: 'lmstudio' } | { kind: 'openrouter'; apiKey: string; model: OpenRouterReplyModel };
  lmStudio: {
    baseUrl: string; model: string; contextTokens: number; timeoutMs: number;
    arabicReply?: { baseUrl: string; model: string; contextTokens: number };
  };
  reviewConcurrency: number;
  reviewAllowedCaptureMethods: ConnectorCaptureMethod[];
  streamRetention: number;
  rateLimitPerMinute: number;
  /**
   * Off (null) unless MIRSAD_CONTACT_SYNC_URL is set: flagged numbers then go to the contact-sync server, which adds them
   * to the "Known Scammer" contact on connected phones. The token is a secret and is never logged.
   */
  contactSync: { url: string; token: string | null; label: string; source: string } | null;
  /** Absolute path of the Telegram controlled-test record that marks the live connector as verified. */
  controlledTestRecordPath: string;
  telegram: {
    liveEnabled: boolean;
    botToken: string | null;
    approvedConnectionId: string | null;
    /** `approved` (the default): only `approvedChatIds`. `all_private`: every private chat, with `allChatsReference`. */
    chatScope: TelegramChatScope;
    approvedChatIds: string[];
    /** The reference of the owner's recorded decision to cover every private chat; required for `all_private`. */
    allChatsReference: string | null;
    /** Chats never stored or answered, in either scope. */
    excludedChatIds: string[];
    approvalReference: string | null;
    /**
     * Opt-in model replies in explicitly approved, AI-active live chats (design section 20). Off by
     * default; it also needs the reference of the recorded consent. With `autoStart`, a chat that was never started is
     * started by the worker when the contact's message there is one it would answer.
     */
    aiReplies: { enabled: boolean; consentReference: string | null; autoStart: boolean; wordingUntilMs?: number };
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

function syncText(env: Env, name: string, fallback: string): string {
  const raw = value(env, name) ?? fallback;
  if (!SYNC_TEXT.test(raw)) throw new ConfigError(name, 'must be 1 to 64 letters, digits, spaces or . _ : ( ) -');
  return raw;
}

function contactSync(env: Env): Config['contactSync'] {
  if (value(env, 'MIRSAD_CONTACT_SYNC_URL') === undefined) return null;
  return {
    url: loopbackUrl(env, 'MIRSAD_CONTACT_SYNC_URL', ''),
    token: value(env, 'MIRSAD_CONTACT_SYNC_TOKEN') ?? null,
    label: syncText(env, 'MIRSAD_CONTACT_SYNC_LABEL', 'Flagged on the Mirsad portal'),
    source: syncText(env, 'MIRSAD_CONTACT_SYNC_SOURCE', 'mirsad-portal'),
  };
}

function reviewMethods(env: Env): ConnectorCaptureMethod[] {
  const name = 'MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS';
  const raw = value(env, name) === undefined ? ['fixture_replay'] : list(env, name);
  for (const method of raw) {
    const known = (CONNECTOR_CAPTURE_METHODS as readonly string[]).includes(method);
    if (!known || method === 'telegram_business_live') {
      throw new ConfigError(name, 'contains a capture method that cannot be reviewed');
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
  const recordPath = controlledTestRecordPath(env);
  const baseUrl = loopbackUrl(env, 'MIRSAD_LMSTUDIO_BASE_URL', 'http://127.0.0.1:1234/v1');
  const contextTokens = int(env, 'MIRSAD_LMSTUDIO_CONTEXT_TOKENS', 4096, 512);
  const arabicModel = value(env, 'MIRSAD_LMSTUDIO_ARABIC_MODEL');
  const replyProvider = oneOf(env, 'MIRSAD_REPLY_PROVIDER', ['lmstudio', 'openrouter'] as const, 'lmstudio');
  const now = Date.now();
  const wordingUntilMs = Date.parse(value(env, 'MIRSAD_TEST_WORDING_UNTIL') ?? '');
  return {
    host,
    port: int(env, 'MIRSAD_PORT', 8787, 0, MAX_PORT),
    dataDir: path.resolve(value(env, 'MIRSAD_DATA_DIR') ?? './data'),
    demoSeed: bool(env, 'MIRSAD_DEMO_SEED', true),
    reviewer: oneOf(env, 'MIRSAD_REVIEWER', REVIEWER_KINDS, 'lmstudio'),
    replyProvider: replyProvider === 'openrouter'
      ? {
        kind: 'openrouter', apiKey: value(env, 'OPENROUTER_API_KEY') ?? '',
        model: oneOf(env, 'MIRSAD_OPENROUTER_MODEL', OPENROUTER_REPLY_MODELS, GEMINI_REPLY_MODEL),
      }
      : { kind: 'lmstudio' },
    lmStudio: {
      baseUrl,
      model: value(env, 'MIRSAD_LMSTUDIO_MODEL') ?? 'qwen3.5-9b',
      contextTokens,
      ...(arabicModel && { arabicReply: {
        model: arabicModel,
        baseUrl: loopbackUrl(env, 'MIRSAD_LMSTUDIO_ARABIC_BASE_URL', baseUrl),
        contextTokens: int(env, 'MIRSAD_LMSTUDIO_ARABIC_CONTEXT_TOKENS', contextTokens, 512),
      } }),
      timeoutMs: int(env, 'MIRSAD_LMSTUDIO_TIMEOUT_MS', 120_000, 1),
    },
    reviewConcurrency: int(env, 'MIRSAD_REVIEW_CONCURRENCY', 2, 1, 64),
    reviewAllowedCaptureMethods: reviewMethods(env),
    streamRetention: int(env, 'MIRSAD_STREAM_RETENTION', 5000, 1),
    rateLimitPerMinute: int(env, 'MIRSAD_RATE_LIMIT_PER_MINUTE', 600, 1),
    contactSync: contactSync(env),
    controlledTestRecordPath: recordPath,
    telegram: {
      liveEnabled: bool(env, 'TELEGRAM_LIVE_ENABLED', false),
      botToken: value(env, 'TELEGRAM_BOT_TOKEN') ?? null,
      approvedConnectionId: value(env, 'TELEGRAM_APPROVED_CONNECTION_ID') ?? null,
      chatScope: oneOf(env, 'TELEGRAM_CHAT_SCOPE', TELEGRAM_CHAT_SCOPES, 'approved'),
      approvedChatIds: list(env, 'TELEGRAM_APPROVED_CHAT_IDS'),
      allChatsReference: value(env, 'TELEGRAM_ALL_CHATS_REFERENCE') ?? null,
      excludedChatIds: list(env, 'TELEGRAM_EXCLUDED_CHAT_IDS'),
      approvalReference: value(env, 'TELEGRAM_APPROVAL_REFERENCE') ?? null,
      aiReplies: {
        ...(wordingUntilMs > now && wordingUntilMs <= now + 15 * 60_000 && { wordingUntilMs }),
        enabled: bool(env, 'TELEGRAM_AI_REPLIES_ENABLED', false),
        consentReference: value(env, 'TELEGRAM_AI_REPLY_CONSENT_REFERENCE') ?? null,
        autoStart: bool(env, 'TELEGRAM_AI_AUTO_START', false),
      },
    },
  };
}
