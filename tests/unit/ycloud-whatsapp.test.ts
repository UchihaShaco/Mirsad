import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createYCloudSender, createYCloudWebhook } from '../../src/adapters/whatsapp/ycloud.ts';

const now = Date.parse('2026-11-24T10:09:08Z');
const ts = Math.floor(now / 1000);
const url = 'http://127.0.0.1/webhooks/whatsapp';
const business = '+12025550105';
const tester = '+12025550111';
const options = { businessNumber: business, wabaId: '2468', webhookSecret: 'synthetic-secret', testerIds: [tester], now: () => now };
const fixture = {
  id: 'provider-message-id', wamid: 'wamid.incoming', type: 'text', from: tester,
  to: business, wabaId: '2468', sendTime: '2026-11-24T10:00:00Z', text: { body: 'مرحبا' },
};
const incoming = { apiVersion: 'v2', type: 'whatsapp.inbound_message.received', whatsappInboundMessage: fixture };
const echo = { apiVersion: 'v2', type: 'whatsapp.smb.message.echoes', whatsappMessage: { ...fixture, from: business, to: tester } };

function signed(body: unknown, timestamp = ts, extra = ''): Request {
  const json = JSON.stringify(body);
  const digest = createHmac('sha256', options.webhookSecret).update(String(timestamp) + '.' + json).digest('hex');
  return new Request(url, { method: 'POST', body: json + extra, headers: { 'YCloud-Signature': 't=' + timestamp + ',s=' + digest } });
}

describe('YCloud callbacks for the connected Business app', () => {
  it('maps signed incoming and manual echo messages to distinct native directions and uses WhatsApp IDs', async () => {
    const onIncoming = vi.fn();
    const onOutgoing = vi.fn();
    const receive = createYCloudWebhook({ ...options, onIncoming, onOutgoing });
    expect((await receive(signed(incoming))).status).toBe(200);
    expect((await receive(signed(echo))).status).toBe(200);
    const common = { id: fixture.wamid, text: fixture.text.body, sentAt: '2026-11-24T10:00:00.000Z' };
    expect(onIncoming).toHaveBeenCalledExactlyOnceWith({ ...common, from: tester.slice(1) });
    expect(onOutgoing).toHaveBeenCalledExactlyOnceWith({ ...common, to: tester.slice(1) });
  });

  it('requires the timestamped signature over the exact payload bytes before intake', async () => {
    const onIncoming = vi.fn();
    const receive = createYCloudWebhook({ ...options, onIncoming });
    expect((await receive(signed(incoming, ts, ' '))).status).toBe(403);
    for (const offset of [-301, 301]) expect((await receive(signed(incoming, ts + offset))).status).toBe(403);
    for (const header of ['', 't=1,s=not-a-digest', 's=abc,t=1,t=2']) {
      const req = signed(incoming);
      req.headers.set('YCloud-Signature', header);
      expect((await receive(req)).status).toBe(403);
    }
    expect(onIncoming).not.toHaveBeenCalled();
  });

  it('acknowledges and ignores out-of-scope senders, accounts, groups, history, hidden or invalid messages', async () => {
    const onIncoming = vi.fn();
    const onOutgoing = vi.fn();
    const receive = createYCloudWebhook({ ...options, onIncoming, onOutgoing });
    for (const change of [
      { wabaId: '123' }, { to: '+12025550191' }, { from: '+12025550191' }, { groupId: 'test-group' },
      { from: undefined, fromUserId: 'US.fixture' }, { type: 'image' }, { wamid: undefined }, { wamid: 'provider-id' },
      { sendTime: '123' }, { text: { body: ' ' } },
    ]) {
      expect((await receive(signed({ ...incoming, whatsappInboundMessage: { ...fixture, ...change } }))).status).toBe(200);
    }
    for (const event of [
      { ...incoming, type: 'whatsapp.smb.history' }, { ...incoming, apiVersion: 'v1' },
      { ...echo, type: 'whatsapp.message.updated' }, { ...echo, whatsappMessage: { ...fixture, to: tester } },
    ]) expect((await receive(signed(event))).status).toBe(200);
    expect(onIncoming).not.toHaveBeenCalled();
    expect(onOutgoing).not.toHaveBeenCalled();
  });

  it('limits streaming bodies and serves only the dedicated POST route', async () => {
    const receive = createYCloudWebhook({ ...options, onIncoming: vi.fn() });
    const oversized = signed('x'.repeat(3 * 1024 * 1024));
    oversized.headers.set('content-length', '16');
    expect((await receive(oversized)).status).toBe(413);
    expect((await receive(new Request(url))).status).toBe(405);
    expect((await receive(new Request(new URL('/v1/chats', url)))).status).toBe(404);
  });

  it('lets the provider retry an uncommitted incoming message and redacts the callback error', async () => {
    const onIncoming = vi.fn().mockRejectedValueOnce(new Error('private text')).mockResolvedValue(undefined);
    const receive = createYCloudWebhook({ ...options, onIncoming });
    const failed = await receive(signed(incoming));
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe('');
    expect((await receive(signed(incoming))).status).toBe(200);
    expect(onIncoming).toHaveBeenCalledTimes(2);
  });
});

describe('YCloud synchronous send', () => {
  const settings = { apiKey: 'synthetic-api-key', businessNumber: business };
  it('sends a contextual text from the configured number and returns the WhatsApp message ID', async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'ycloud.internal', wamid: 'wamid.sent' }));
    const sender = createYCloudSender({ ...settings, fetch: call });
    expect(await sender.sendText(tester.slice(1), 'Hello!', fixture.wamid)).toBe('wamid.sent');
    const [endpoint, init] = call.mock.calls[0]!;
    expect(endpoint).toBe('https://api.ycloud.com/v2/whatsapp/messages/sendDirectly');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('X-API-Key')).toBe(settings.apiKey);
    expect(JSON.parse(String(init?.body))).toEqual({ from: business, to: tester, type: 'text',
      text: { body: 'Hello!', preview_url: false }, context: { message_id: fixture.wamid } });
  });

  it('rejects invalid destinations before sending, never retries an ambiguous result, and hides upstream data', async () => {
    const call = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'provider-only' })).mockRejectedValueOnce(new Error('secret'))
      .mockResolvedValueOnce(Response.json({ message: 'secret' }, { status: 401 }));
    const sender = createYCloudSender({ ...settings, fetch: call });
    await expect(sender.sendText('group', 'hello', fixture.wamid)).rejects.toThrow(/^ycloud_send_invalid_message$/);
    await expect(sender.sendText(tester, 'hello', 'internal-y-id')).rejects.toThrow(/^ycloud_send_invalid_message$/);
    expect(call).not.toHaveBeenCalled();
    for (const expected of ['ycloud_send_invalid_response', 'ycloud_send_network', 'ycloud_send_http_401']) {
      await expect(sender.sendText(tester, 'hello', fixture.wamid)).rejects.toThrow(new RegExp('^' + expected + '$'));
    }
    expect(call).toHaveBeenCalledTimes(3);
  });
});
