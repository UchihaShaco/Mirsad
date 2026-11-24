import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { LIMITS } from '../../contract/schemas.ts';
import {
  phone, readBounded, record, validMessageId,
  type WhatsAppIncoming, type WhatsAppOutgoing, type WhatsAppSender,
} from './cloud.ts';

interface WebhookOptions {
  businessNumber: string;
  wabaId: string;
  webhookSecret: string;
  testerIds: readonly string[];
  onIncoming(message: WhatsAppIncoming): void | Promise<void>;
  onOutgoing?(message: WhatsAppOutgoing): void | Promise<void>;
  now?: () => number;
}

const SIGNATURE_TOLERANCE_SECONDS = 300;
const WEBHOOK_BYTES = 3 * 1024 * 1024;
const SEND_URL = 'https://api.ycloud.com/v2/whatsapp/messages/sendDirectly';
const SEND_TIMEOUT_MS = 15_000;
const RESPONSE_BYTES = 64 * 1024;
const sendTime = z.iso.datetime({ offset: true });

function wamid(id: unknown): id is string {
  return validMessageId(id) && id.startsWith('wamid.') && id.length > 6;
}

function signatureFields(header: string | null, now: number) {
  const fields = header?.split(',').map(field => field.trim());
  if (fields?.length !== 2) return null;
  const time = fields.find(field => /^t=\d{1,12}$/.test(field))?.slice(2);
  const digest = fields.find(field => /^s=[a-f0-9]{64}$/i.test(field))?.slice(2);
  if (!time || !digest || Math.abs(Math.floor(now / 1000) - Number(time)) > SIGNATURE_TOLERANCE_SECONDS) return null;
  return { time, digest };
}

function messageFor(payload: unknown, wabaId: string, business: string, testers: ReadonlySet<string>): WhatsAppIncoming | WhatsAppOutgoing | null {
  const event = record(payload);
  if (event?.apiVersion !== 'v2') return null;
  const outgoing = event.type === 'whatsapp.smb.message.echoes';
  if (!outgoing && event.type !== 'whatsapp.inbound_message.received') return null;
  const message = record(outgoing ? event.whatsappMessage : event.whatsappInboundMessage);
  if (message?.type !== 'text' || message.wabaId !== wabaId || 'groupId' in message) return null;
  const peer = phone(outgoing ? message.to : message.from);
  if (!peer || !testers.has(peer) || phone(outgoing ? message.from : message.to) !== business) return null;
  const text = record(message.text)?.body;
  if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.messageTextMax) return null;
  // Only the WhatsApp ID can be used in context.message_id. The envelope and YCloud object have separate IDs.
  const id = message.wamid;
  const time = sendTime.safeParse(message.sendTime);
  if (!wamid(id) || !time.success) return null;
  const sentAt = new Date(time.data).toISOString();
  return outgoing ? { id, to: peer, text, sentAt } : { id, from: peer, text, sentAt };
}

export function createYCloudWebhook(options: WebhookOptions): (request: Request) => Promise<Response> {
  const business = phone(options.businessNumber);
  if (!business || !/^[1-9]\d{0,31}$/.test(options.wabaId) || !options.webhookSecret.trim()) {
    throw new Error('ycloud_webhook_invalid_config');
  }
  const testers = new Set<string>();
  for (const tester of options.testerIds) {
    const number = phone(tester);
    if (!number || number === business) throw new Error('ycloud_webhook_invalid_tester');
    testers.add(number);
  }
  const now = options.now ?? Date.now;
  return async request => {
    if (new URL(request.url).pathname !== '/webhooks/whatsapp') return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    const fields = signatureFields(request.headers.get('YCloud-Signature'), now());
    if (!fields) return new Response(null, { status: 403 });

    let payload: unknown;
    try {
      const bytes = await readBounded(request, WEBHOOK_BYTES);
      if (!bytes) return new Response(null, { status: 413 });
      const digest = createHmac('sha256', options.webhookSecret).update(fields.time + '.').update(bytes).digest();
      if (!timingSafeEqual(digest, Buffer.from(fields.digest, 'hex'))) return new Response(null, { status: 403 });
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      return new Response(null, { status: 400 });
    }

    const message = messageFor(payload, options.wabaId, business, testers);
    try {
      if (message && 'to' in message) await options.onOutgoing?.(message);
      else if (message) await options.onIncoming(message);
    } catch {
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 200 });
  };
}

export function createYCloudSender(options: { businessNumber: string; apiKey: string; fetch?: typeof fetch }): WhatsAppSender {
  const business = phone(options.businessNumber);
  if (!business || !options.apiKey || /\s/.test(options.apiKey)) throw new Error('ycloud_send_invalid_config');
  const call = options.fetch ?? fetch;
  return {
    async sendText(to, text, replyTo) {
      const recipient = phone(to);
      if (!recipient || recipient === business || !text.trim() || [...text].length > 4096 || !wamid(replyTo)) {
        throw new Error('ycloud_send_invalid_message');
      }
      let response: Response;
      try {
        response = await call(SEND_URL, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          headers: { 'X-API-Key': options.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: '+' + business, to: '+' + recipient, type: 'text',
            text: { body: text, preview_url: false }, context: { message_id: replyTo },
          }),
        });
      } catch {
        throw new Error('ycloud_send_network');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error('ycloud_send_http_' + response.status);
      }
      let result: Record<string, unknown> | undefined;
      try {
        const bytes = await readBounded(response, RESPONSE_BYTES);
        if (bytes) result = record(JSON.parse(bytes.toString('utf8')));
      } catch {
        // The provider may already have sent the reply. The worker records an uncertain outcome.
      }
      if (!wamid(result?.wamid) || result.status === 'failed' || result.errorCode) throw new Error('ycloud_send_invalid_response');
      return result.wamid;
    },
  };
}
