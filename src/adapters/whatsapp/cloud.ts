import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { LIMITS } from '../../contract/schemas.ts';

export interface WhatsAppIncoming {
  id: string;
  from: string;
  text: string;
  sentAt: string;
}

export interface WhatsAppOutgoing {
  id: string;
  to: string;
  text: string;
  sentAt: string;
}

export interface WhatsAppSender {
  sendText(to: string, text: string, replyTo: string): Promise<string>;
}

interface WebhookOptions {
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  testerIds: readonly string[];
  /** Must commit idempotently before resolving. Meta can redeliver an entire batch. */
  onIncoming(message: WhatsAppIncoming): void | Promise<void>;
  onOutgoing?(message: WhatsAppOutgoing): void | Promise<void>;
}

interface SenderOptions {
  phoneNumberId: string;
  accessToken: string;
  graphVersion: string;
  fetch?: typeof fetch;
}

const WEBHOOK_BYTES = 3 * 1024 * 1024;
const GRAPH_RESPONSE_BYTES = 64 * 1024;
const GRAPH_TIMEOUT_MS = 15_000;
const TEXT_REPLY_MAX = 4096;
const PHONE_NUMBER_ID = /^[0-9]{1,32}$/;

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function phone(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\+?[1-9]\d{1,14}$/.test(value)) return null;
  return value.replace(/^\+/, '');
}

export function validMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= LIMITS.sourceIdMax && /^[!-~]+$/.test(value);
}

function* messages(payload: unknown, phoneNumberId: string, testers: ReadonlySet<string>): Generator<WhatsAppIncoming | WhatsAppOutgoing> {
  const envelope = record(payload);
  if (envelope?.object !== 'whatsapp_business_account') return;
  for (const entry of list(envelope.entry)) {
    for (const change of list(record(entry)?.changes)) {
      const topic = record(change);
      const echo = topic?.field === 'smb_message_echoes';
      if (!echo && topic?.field !== 'messages') continue;
      const value = record(topic?.value);
      const metadata = record(value?.metadata);
      if (value?.messaging_product !== 'whatsapp' || metadata?.phone_number_id !== phoneNumberId) continue;
      for (const item of list(echo ? value.message_echoes : value.messages)) {
        const message = record(item);
        if (message?.type !== 'text' || 'group_id' in message || !validMessageId(message.id)) continue;
        const peer = phone(echo ? message.to : message.from);
        if (!peer || !testers.has(peer)) continue;
        if (echo && (!phone(message.from) || phone(message.from) !== phone(metadata.display_phone_number))) continue;
        const text = record(message.text)?.body;
        if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.messageTextMax) continue;
        if (typeof message.timestamp !== 'string' && typeof message.timestamp !== 'number') continue;
        if (!/^\d{1,11}$/.test(String(message.timestamp))) continue;
        const sentAt = new Date(Number(message.timestamp) * 1000).toISOString();
        yield echo ? { id: message.id, to: peer, text, sentAt } : { id: message.id, from: peer, text, sentAt };
      }
    }
  }
}

/** A missing or incorrect Content-Length cannot bypass the running byte limit. */
export async function readBounded(input: Request | Response, limit: number): Promise<Buffer | null> {
  if (Number(input.headers.get('content-length')) > limit) return null;
  const reader = input.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function verification(query: URLSearchParams, verifyToken: string): Response {
  const token = query.get('hub.verify_token');
  const challenge = query.get('hub.challenge');
  if (query.get('hub.mode') !== 'subscribe' || !token || !challenge) return new Response(null, { status: 403 });
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(token), digest(verifyToken))) return new Response(null, { status: 403 });
  return new Response(challenge, { headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
}

export function createWhatsAppWebhook(options: WebhookOptions): (request: Request) => Promise<Response> {
  if (!PHONE_NUMBER_ID.test(options.phoneNumberId) || !options.verifyToken || !options.appSecret) {
    throw new Error('whatsapp_webhook_invalid_config');
  }
  const testers = new Set<string>();
  for (const tester of options.testerIds) {
    const number = phone(tester);
    if (!number) throw new Error('whatsapp_webhook_invalid_tester');
    testers.add(number);
  }
  return async request => {
    const url = new URL(request.url);
    if (url.pathname !== '/webhooks/whatsapp') return new Response(null, { status: 404 });
    if (request.method === 'GET') return verification(url.searchParams, options.verifyToken);
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });

    const signature = request.headers.get('x-hub-signature-256');
    if (!signature || !/^sha256=[\da-f]{64}$/i.test(signature)) return new Response(null, { status: 403 });
    let payload: unknown;
    try {
      const bytes = await readBounded(request, WEBHOOK_BYTES);
      if (!bytes) return new Response(null, { status: 413 });
      const expected = createHmac('sha256', options.appSecret).update(bytes).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) return new Response(null, { status: 403 });
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      return new Response(null, { status: 400 });
    }
    try {
      for (const message of messages(payload, options.phoneNumberId, testers)) {
        if ('to' in message) await options.onOutgoing?.(message);
        else await options.onIncoming(message);
      }
    } catch {
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 200 });
  };
}

export function createWhatsAppSender(options: SenderOptions): WhatsAppSender {
  if (!PHONE_NUMBER_ID.test(options.phoneNumberId) || !/^v[1-9]\d{0,2}\.\d{1,2}$/.test(options.graphVersion)
      || !options.accessToken || /\s/.test(options.accessToken)) throw new Error('whatsapp_send_invalid_config');
  const endpoint = `https://graph.facebook.com/${options.graphVersion}/${options.phoneNumberId}/messages`;
  const call = options.fetch ?? fetch;
  return {
    async sendText(to, text, replyTo) {
      const recipient = phone(to);
      if (!recipient || !text.trim() || [...text].length > TEXT_REPLY_MAX || !validMessageId(replyTo)) {
        throw new Error('whatsapp_send_invalid_message');
      }
      let response: Response;
      try {
        response = await call(endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
          headers: { authorization: `Bearer ${options.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient,
            type: 'text', context: { message_id: replyTo }, text: { body: text, preview_url: false } }),
        });
      } catch {
        throw new Error('whatsapp_send_network');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`whatsapp_send_http_${response.status}`);
      }
      let accepted: unknown;
      try {
        const bytes = await readBounded(response, GRAPH_RESPONSE_BYTES);
        if (bytes) accepted = JSON.parse(bytes.toString('utf8'));
      } catch {
        // Ambiguous delivery. Never repeat a send because the response could not be read.
      }
      const id = record(list(record(accepted)?.messages)[0])?.id;
      if (!validMessageId(id)) throw new Error('whatsapp_send_invalid_response');
      return id;
    },
  };
}
