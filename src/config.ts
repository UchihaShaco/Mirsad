/** The service and LM Studio bind to loopback. Telegram replies can opt in to a fixed OpenRouter endpoint. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTOR_CAPTURE_METHODS,
  REVIEWER_KINDS,
  type ConnectorCaptureMethod,
  type ReviewerKind,
} from './contract/enums.ts';
import { DEFAULT_CONTROLLED_TEST_RECORD, hasValidControlledTestRecord } from './contract/controlled-test-record.ts';
import { GEMINI_REPLY_MODEL, OPENROUTER_REPLY_MODELS, type OpenRouterReplyModel } from './replies/openrouter-reply-generator.ts';

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;
/**
 * Which Telegram chats the live connector stores and the reply worker answers (design section 13): only the approved
 * list, or every private chat of the connected account (the owner's decision, with its own reference).
 */
export const TELEGRAM_CHAT_SCOPES = ['approved', 'all_private'] as const;
export type TelegramChatScope = (typeof TELEGRAM_CHAT_SCOPES)[number];
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
  replyProvider: { kind: 'lmstudio' } | { kind: 'openrouter'; apiKey: string; model: OpenRouterReplyModel };
  lmStudio: {
    baseUrl: string; model: string; contextTokens: number; timeoutMs: number;
    arabicReply?: { baseUrl: string; model: string; contextTokens: number };
  };
  reviewConcurrency: number;
  reviewAllowedCaptureMethods: ConnectorCaptureMethod[];
  streamRetention: number;
  rateLimitPerMinute: number;
  whatsappImportEnabled: boolean;
  whatsappDemoInvalidSetting?: string;
  whatsappDemo?: {
    officerId: string; testerIds: string[]; webhookPort: number; geminiApiKey: string;
  } & (
    | { provider?: 'meta'; phoneNumberId: string; accessToken: string; appSecret: string; verifyToken: string; graphVersion: string }
    | { provider: 'ycloud'; wabaId: string; businessNumber: string; apiKey: string; webhookSecret: string }
  );
  /** Absolute path of the Telegram controlled-test record that opens the WhatsApp gate. */
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

function reviewMethods(env: Env): ConnectorCaptureMethod[] {
  const name = 'MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS';
  const raw = value(env, name) === undefined ? ['fixture_replay'] : list(env, name);
  for (const method of raw) {
    const known = (CONNECTOR_CAPTURE_METHODS as readonly string[]).includes(method);
    if (!known || method === 'telegram_business_live' || method === 'whatsapp_business_live') {
      throw new ConfigError(name, 'contains a capture method that cannot be reviewed');
    }
  }
  return raw as ConnectorCaptureMethod[];
}

function controlledTestRecordPath(env: Env): string {
  const raw = value(env, 'MIRSAD_CONTROLLED_TEST_RECORD') ?? DEFAULT_CONTROLLED_TEST_RECORD;
  return path.resolve(PROJECT_ROOT, raw);
}

function whatsappDemoSettings(env: Env, portalPort: number): Config['whatsappDemo'] {
  if (!bool(env, 'WHATSAPP_DEMO_ENABLED', false)) return undefined;
  function required(name: string, format?: RegExp): string {
    const setting = value(env, name);
    if (!setting || (format && !format.test(setting))) throw new ConfigError(name, 'is required in a valid format for the WhatsApp demo');
    return setting;
  }
  const testerIds = [...new Set(list(env, 'WHATSAPP_DEMO_TESTERS').map(id => id.replace(/^\+/, '')))];
  if (!testerIds.length || testerIds.some(id => !/^[1-9]\d{6,14}$/.test(id))) {
    throw new ConfigError('WHATSAPP_DEMO_TESTERS', 'enter enrolled tester numbers including country codes');
  }
  const webhookPort = int(env, 'WHATSAPP_WEBHOOK_PORT', 8788, 1, MAX_PORT);
  if (webhookPort === portalPort) throw new ConfigError('WHATSAPP_WEBHOOK_PORT', 'must have its own port');
  const provider = oneOf(env, 'WHATSAPP_PROVIDER', ['meta', 'ycloud'] as const, 'meta');
  const common = {
    testerIds, webhookPort,
    officerId: required('WHATSAPP_DEMO_OFFICER_ID', /^prn_[a-f0-9]{32}$/),
    geminiApiKey: required('OPENROUTER_API_KEY'),
  };
  if (provider === 'ycloud') {
    return {
      ...common, provider, wabaId: required('YCLOUD_WABA_ID', /^[1-9]\d{0,19}$/),
      businessNumber: required('YCLOUD_BUSINESS_NUMBER', /^\+[1-9]\d{6,14}$/),
      apiKey: required('YCLOUD_API_KEY', /^\S+$/), webhookSecret: required('YCLOUD_WEBHOOK_SECRET'),
    };
  }
  const graphVersion = value(env, 'WHATSAPP_GRAPH_VERSION') ?? 'v27.0';
  if (!/^v[1-9]\d?\.0$/.test(graphVersion)) throw new ConfigError('WHATSAPP_GRAPH_VERSION', 'use a Graph API version such as v27.0');
  return {
    ...common, provider, graphVersion,
    phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID', /^[1-9]\d{0,19}$/),
    accessToken: required('WHATSAPP_ACCESS_TOKEN'), appSecret: required('WHATSAPP_APP_SECRET'),
    verifyToken: required('WHATSAPP_VERIFY_TOKEN'),
  };
}

export function loadConfig(env: Env): Config {
  const host = value(env, 'MIRSAD_HOST') ?? '127.0.0.1';
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(host)) {
    throw new ConfigError('MIRSAD_HOST', `must be one of ${LOOPBACK_HOSTS.join(', ')}`);
  }
  const whatsappImportEnabled = bool(env, 'MIRSAD_WHATSAPP_IMPORT_ENABLED', false);
  const recordPath = controlledTestRecordPath(env);
  const approvalReference = value(env, 'TELEGRAM_APPROVAL_REFERENCE');
  const baseUrl = loopbackUrl(env, 'MIRSAD_LMSTUDIO_BASE_URL', 'http://127.0.0.1:1234/v1');
  const contextTokens = int(env, 'MIRSAD_LMSTUDIO_CONTEXT_TOKENS', 4096, 512);
  const arabicModel = value(env, 'MIRSAD_LMSTUDIO_ARABIC_MODEL');
  const replyProvider = oneOf(env, 'MIRSAD_REPLY_PROVIDER', ['lmstudio', 'openrouter'] as const, 'lmstudio');
  const now = Date.now();
  const wordingUntilMs = Date.parse(value(env, 'MIRSAD_TEST_WORDING_UNTIL') ?? '');
  if (whatsappImportEnabled && !hasValidControlledTestRecord(recordPath, approvalReference)) {
    throw new ConfigError('MIRSAD_WHATSAPP_IMPORT_ENABLED', 'requires a verified Telegram controlled-test record');
  }
  const portalPort = int(env, 'MIRSAD_PORT', 8787, 0, MAX_PORT);
  let whatsappDemo: Config['whatsappDemo'];
  let whatsappDemoInvalidSetting: string | undefined;
  try {
    whatsappDemo = whatsappDemoSettings(env, portalPort);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    whatsappDemoInvalidSetting = error.variable;
  }
  return {
    host,
    port: portalPort,
    ...(whatsappDemo && { whatsappDemo }),
    ...(whatsappDemoInvalidSetting && { whatsappDemoInvalidSetting }),
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
    whatsappImportEnabled,
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
