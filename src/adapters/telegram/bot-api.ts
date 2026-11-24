/**
 * Telegram Bot API clients (design sections 19.8 and 20). `createBotApi` is the connector's read-only client: it has no
 * method that sends, edits, deletes or marks a message read. `createBotSender` is a separate client with exactly one
 * method, a reply in a business chat, used only by the opt-in local-model replies. Telegram puts the bot token in the
 * request path, so every URL is built in `call` and never appears in an error or a log line; error descriptions from
 * Telegram are redacted before they are kept.
 */
import { z } from 'zod';
import { telegramUpdateSchema } from './fixture-schema.ts';

export const BUSINESS_UPDATE_TYPES = [
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
] as const;
export type BusinessUpdateType = (typeof BUSINESS_UPDATE_TYPES)[number];

export type BotApiMethod = 'getMe' | 'getWebhookInfo' | 'getBusinessConnection' | 'getUpdates' | 'sendMessage' | 'deleteBusinessMessages';

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
/** `<bot id>:<secret>`; anything else could change the request path, so it is refused. */
const TOKEN_FORMAT = /^\d{1,20}:[A-Za-z0-9_-]{20,128}$/;
/** Time allowed for a call that is not a long poll. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Extra time a long poll may take beyond the timeout Telegram is asked to wait. */
const POLL_GRACE_MS = 10_000;
const MS_PER_SECOND = 1_000;

const rawUpdateSchema = z.looseObject({ update_id: z.number().int() });
export type RawUpdate = z.infer<typeof rawUpdateSchema>;

const botUserSchema = z.looseObject({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
  can_connect_to_business: z.boolean().optional(),
});
export type BotUser = z.infer<typeof botUserSchema>;

const webhookInfoSchema = z.looseObject({
  url: z.string(),
  pending_update_count: z.number().int().nonnegative(),
  allowed_updates: z.array(z.string()).optional(),
  last_error_date: z.number().int().optional(),
  last_error_message: z.string().optional(),
});
export type WebhookInfo = z.infer<typeof webhookInfoSchema>;

const businessConnectionSchema = telegramUpdateSchema.shape.business_connection.unwrap();
export type BusinessConnection = z.infer<typeof businessConnectionSchema>;

/** What Telegram answers to sendMessage: the message as sent (it carries more fields than these). */
const sentMessageSchema = z.looseObject({
  message_id: z.number().int().positive(),
  date: z.number().int(),
  chat: z.looseObject({ id: z.number().int() }),
  from: z.looseObject({ id: z.number().int(), first_name: z.string().optional(), last_name: z.string().optional() }).optional(),
  text: z.string().optional(),
});
export type SentMessage = z.infer<typeof sentMessageSchema>;

const envelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false), error_code: z.number().int().optional(), description: z.string().optional(),
    parameters: z.object({ retry_after: z.number().int().nonnegative().optional() }).nullish().catch(null),
  }),
]);

export type BotApiErrorCode = 'aborted' | 'timeout' | 'network_error' | 'http_error' | 'api_error' | 'invalid_response';

/** A failed Bot API call. Carries the method, a code and Telegram's status; never the token or the URL. */
export class BotApiError extends Error {
  readonly method: BotApiMethod;
  readonly code: BotApiErrorCode;
  readonly status: number | null;
  readonly description: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(method: BotApiMethod, code: BotApiErrorCode, status: number | null = null, description: string | null = null,
    retryAfterSeconds: number | null = null) {
    super(`${method} failed: ${code}${status === null ? '' : ` (${status})`}`);
    this.name = 'BotApiError';
    this.method = method;
    this.code = code;
    this.status = status;
    this.description = description;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface GetUpdatesParams {
  offset?: number;
  timeoutSeconds: number;
  allowedUpdates: readonly BusinessUpdateType[];
}

/** The whole client: four read-only calls. */
export interface BotApi {
  /** The bot itself; `can_connect_to_business` shows whether business mode is on. */
  getMe(signal?: AbortSignal): Promise<BotUser>;
  /** The transport: an empty `url` means no webhook is set, so long polling can be used. */
  getWebhookInfo(signal?: AbortSignal): Promise<WebhookInfo>;
  /** One business connection: owner user, enabled flag and rights. Reads no messages. */
  getBusinessConnection(businessConnectionId: string, signal?: AbortSignal): Promise<BusinessConnection>;
  getUpdates(params: GetUpdatesParams, signal?: AbortSignal): Promise<RawUpdate[]>;
}

/** A plain-text reply in one private chat of the business account, sent through its business connection. */
export interface BusinessReply {
  businessConnectionId: string;
  chatId: number;
  text: string;
}

/** The whole sender: one call. The connector never holds it. */
export interface BotSender {
  sendBusinessMessage(reply: BusinessReply, signal?: AbortSignal): Promise<SentMessage>;
}

/** The destructive client is injected only into the explicitly confirmed officer route. */
export interface TelegramEraser {
  getBusinessConnection(id: string): Promise<BusinessConnection>;
  deleteBusinessMessages(connection: string, messageIds: number[]): Promise<true>;
}

export function createTelegramEraser(options: BotApiOptions): TelegramEraser {
  const client = clientFor(options);
  return {
    getBusinessConnection: createBotApi(options).getBusinessConnection,
    deleteBusinessMessages: (connection, messageIds) => call(client, 'deleteBusinessMessages',
      { business_connection_id: connection, message_ids: messageIds }, z.literal(true), REQUEST_TIMEOUT_MS),
  };
}

export interface BotApiOptions {
  token: string;
  /** Defaults to https://api.telegram.org; plain http is accepted only on a loopback host (tests). */
  baseUrl?: string;
  fetch?: typeof fetch;
}

function checkedBaseUrl(raw: string): string {
  const url = new URL(raw);
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.includes(url.hostname));
  if (!allowed) throw new Error('bot_api_base_url_not_allowed');
  return raw.replace(/\/+$/, '');
}

/** Whether a token has Telegram's `<bot id>:<secret>` shape, the only shape this client puts into a request path. */
export function isWellFormedBotToken(token: string): boolean {
  return TOKEN_FORMAT.test(token);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return null;
  }
}

/** Everything a call needs; the token is kept only here and in the one URL built from it. */
interface Client {
  token: string;
  baseUrl: string;
  fetch: typeof fetch;
}

/** Removes the token, and its secret half, from text Telegram sends back. */
function redact(client: Client, text: string | undefined): string | null {
  if (text === undefined) return null;
  const secret = client.token.slice(client.token.indexOf(':') + 1);
  return text.split(client.token).join('[redacted]').split(secret).join('[redacted]');
}

async function call<T>(client: Client, method: BotApiMethod, body: object, schema: z.ZodType<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    // The only place the token is put into a URL (Telegram's design); the URL never reaches an error or a log.
    response = await client.fetch(`${client.baseUrl}/bot${client.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: combined,
      redirect: 'error',
    });
  } catch {
    throw new BotApiError(method, signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'network_error');
  }
  const envelope = envelopeSchema.safeParse(await readJson(response));
  if (!envelope.success) throw new BotApiError(method, response.ok ? 'invalid_response' : 'http_error', response.status);
  if (!envelope.data.ok) {
    const { error_code: code, description, parameters } = envelope.data;
    throw new BotApiError(method, 'api_error', code ?? response.status, redact(client, description), parameters?.retry_after ?? null);
  }
  const result = schema.safeParse(envelope.data.result);
  if (!result.success) throw new BotApiError(method, 'invalid_response', response.status);
  return result.data;
}

function clientFor(options: BotApiOptions): Client {
  if (!isWellFormedBotToken(options.token)) throw new Error('bot_token_malformed');
  return { token: options.token, baseUrl: checkedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL), fetch: options.fetch ?? fetch };
}

/** The sender for opt-in local-model replies (design section 20): sendMessage on the business connection, nothing else. */
export function createBotSender(options: BotApiOptions): BotSender {
  const client = clientFor(options);
  return Object.freeze({
    sendBusinessMessage: (reply: BusinessReply, signal?: AbortSignal) =>
      call(
        client,
        'sendMessage',
        { business_connection_id: reply.businessConnectionId, chat_id: reply.chatId, text: reply.text },
        sentMessageSchema,
        REQUEST_TIMEOUT_MS,
        signal,
      ),
  });
}

export function createBotApi(options: BotApiOptions): BotApi {
  const client = clientFor(options);
  return Object.freeze({
    getMe: (signal?: AbortSignal) => call(client, 'getMe', {}, botUserSchema, REQUEST_TIMEOUT_MS, signal),
    getWebhookInfo: (signal?: AbortSignal) => call(client, 'getWebhookInfo', {}, webhookInfoSchema, REQUEST_TIMEOUT_MS, signal),
    getBusinessConnection: (businessConnectionId: string, signal?: AbortSignal) =>
      call(
        client,
        'getBusinessConnection',
        { business_connection_id: businessConnectionId },
        businessConnectionSchema,
        REQUEST_TIMEOUT_MS,
        signal,
      ),
    getUpdates: (params: GetUpdatesParams, signal?: AbortSignal) =>
      call(
        client,
        'getUpdates',
        {
          ...(params.offset === undefined ? {} : { offset: params.offset }),
          timeout: params.timeoutSeconds,
          allowed_updates: [...params.allowedUpdates],
        },
        z.array(rawUpdateSchema),
        params.timeoutSeconds * MS_PER_SECOND + POLL_GRACE_MS,
        signal,
      ),
  });
}
