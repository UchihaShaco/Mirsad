import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createWhatsAppSender, createWhatsAppWebhook, type WhatsAppIncoming, type WhatsAppOutgoing } from '../../src/adapters/whatsapp/cloud.ts';

const url = 'http://127.0.0.1/webhooks/whatsapp';
const options = { phoneNumberId: '101', verifyToken: 'fixture-verify', appSecret: 'fixture-app-secret', testerIds: ['+12025550173'] };
const message = { id: 'wamid.fixture', from: '12025550173', text: { body: 'مرحبا' }, type: 'text', timestamp: '1700000000' };
function change(messages: unknown[], phoneNumberId = options.phoneNumberId, field = 'messages') {
  return { field, value: { metadata: { phone_number_id: phoneNumberId }, messaging_product: 'whatsapp', messages } };
}
function envelope(changes: unknown[]) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes }] });
}
function request(body: string, signedBody = body) {
  const digest = createHmac('sha256', options.appSecret).update(signedBody).digest('hex');
  return new Request(url, { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=' + digest } });
}
describe('WhatsApp Cloud callback', () => {
  it('answers the verified challenge exclusively on the callback path', async () => {
    const receive = createWhatsAppWebhook({ ...options, onIncoming: vi.fn() });
    const query = '?hub.mode=subscribe&hub.verify_token=fixture-verify&hub.challenge=00123';
    expect(await (await receive(new Request(url + query))).text()).toBe('00123');
    expect((await receive(new Request(url + query.replace('fixture-verify', 'wrong')))).status).toBe(403);
    expect((await receive(new Request(new URL('/v1/chats' + query, url)))).status).toBe(404);
    expect((await receive(new Request(url, { method: 'DELETE' }))).status).toBe(405);
  });

  it('checks the exact bytes and filters individual text by sender, account and topic', async () => {
    const onIncoming = vi.fn<(input: WhatsAppIncoming) => void>();
    const receive = createWhatsAppWebhook({ ...options, onIncoming });
    const body = envelope([
      change([message], '102'), change([message], options.phoneNumberId, 'smb_message_echoes'),
      change([{ ...message, from: '12025550171' }, { ...message, group_id: 'group.1' },
        { ...message, type: 'image' }, { ...message, timestamp: 'unknown' },
        { ...message, from: undefined, from_user_id: 'US.123' }, { ...message, from: '+12025550173' }]),
      { field: 'messages', value: { metadata: { phone_number_id: '101' }, statuses: [{ id: 'wamid.fixture' }] } },
    ]);
    expect((await receive(request(body + ' ', body))).status).toBe(403);
    expect(onIncoming).not.toHaveBeenCalled();
    expect((await receive(request(body))).status).toBe(200);
    expect(onIncoming.mock.calls).toEqual([[{ id: message.id, sentAt: '2023-11-14T22:13:20.000Z', from: message.from, text: message.text.body }]]);
  });

  it('delivers only enrolled one-to-one outgoing text echoes to the outgoing callback', async () => {
    const onIncoming = vi.fn();
    const onOutgoing = vi.fn<(input: WhatsAppOutgoing) => void>();
    const receive = createWhatsAppWebhook({ ...options, onIncoming, onOutgoing });
    const owner = '12025550174';
    const echo = { ...message, from: owner, to: message.from };
    const echoed = { field: 'smb_message_echoes', value: { messaging_product: 'whatsapp',
      metadata: { phone_number_id: '101', display_phone_number: owner },
      message_echoes: [echo, { ...echo, to: '12025550175' }, { ...echo, type: 'edit' },
        { ...echo, group_id: 'group.1' }, { ...echo, from: message.from }] } };
    const wrongAccount = { ...echoed, value: { ...echoed.value, metadata: { phone_number_id: '999', display_phone_number: owner } } };
    expect((await receive(request(envelope([wrongAccount, echoed])))).status).toBe(200);
    expect(onIncoming).not.toHaveBeenCalled();
    expect(onOutgoing.mock.calls).toEqual([[{ id: message.id, sentAt: '2023-11-14T22:13:20.000Z', to: message.from, text: message.text.body }]]);
  });

  it('rejects oversized streaming bodies even with a false length header', async () => {
    const receive = createWhatsAppWebhook({ ...options, onIncoming: vi.fn() });
    const req = request('x'.repeat(4 * 1024 * 1024));
    req.headers.set('content-length', '1');
    expect((await receive(req)).status).toBe(413);
  });

  it('allows Meta to retry an uncommitted message without leaking diagnostics', async () => {
    const onIncoming = vi.fn().mockRejectedValueOnce(new Error('sensitive content')).mockResolvedValue(undefined);
    const receive = createWhatsAppWebhook({ ...options, onIncoming });
    const body = envelope([change([message])]);
    const first = await receive(request(body));
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain('sensitive');
    expect((await receive(request(body))).status).toBe(200);
    expect(onIncoming).toHaveBeenCalledTimes(2);
  });
});

describe('WhatsApp Cloud send', () => {
  const senderOptions = { phoneNumberId: options.phoneNumberId, accessToken: 'fixture-token', graphVersion: 'v27.0' };
  it('sends a contextual individual text over the fixed Graph endpoint and returns the accepted message ID', async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ messages: [{ id: 'wamid.sent' }] }));
    const sender = createWhatsAppSender({ ...senderOptions, fetch: call });
    expect(await sender.sendText(message.from, 'Hello', message.id)).toBe('wamid.sent');
    const [endpoint, init] = call.mock.calls[0]!;
    expect(endpoint).toBe('https://graph.facebook.com/v27.0/101/messages');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual',
      to: message.from, type: 'text', context: { message_id: message.id }, text: { body: 'Hello', preview_url: false } });
  });

  it('rejects malformed config, unaddressable recipients and over-length replies before network I/O', async () => {
    const call = vi.fn<typeof fetch>();
    expect(() => createWhatsAppSender({ ...senderOptions, graphVersion: 'v27.0/../x' })).toThrow();
    expect(() => createWhatsAppSender({ ...senderOptions, phoneNumberId: '1?redirect=x' })).toThrow();
    const sender = createWhatsAppSender({ ...senderOptions, fetch: call });
    await expect(sender.sendText('group.1234', 'hello', message.id)).rejects.toThrow();
    await expect(sender.sendText(message.from, 'a'.repeat(4097), message.id)).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it('returns code-only errors without retrying ambiguous sends', async () => {
    const call = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('private failure'))
      .mockResolvedValueOnce(Response.json({ error: { message: 'private failure' } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ messages: [{}] }));
    const sender = createWhatsAppSender({ ...senderOptions, fetch: call });
    await expect(sender.sendText(message.from, 'hello', message.id)).rejects.toThrow(/^whatsapp_send_network$/);
    await expect(sender.sendText(message.from, 'hello', message.id)).rejects.toThrow(/^whatsapp_send_http_401$/);
    await expect(sender.sendText(message.from, 'hello', message.id)).rejects.toThrow(/^whatsapp_send_invalid_response$/);
    expect(call).toHaveBeenCalledTimes(3);
  });
});
