import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApp, type App } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { ListChatsResponse, Timeline } from '../../src/contract/schemas.ts';
import { provisionPrincipal, provisionWorkspace } from '../../src/identity/provision.ts';
import { openDatabase, DATABASE_FILE } from '../../src/storage/db.ts';

it.each(['meta', 'ycloud'] as const)('answers the first signed %s text through Dispatch and survives redelivery and restart', async provider => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-whatsapp-'));
  const db = openDatabase(path.join(dataDir, DATABASE_FILE));
  const officer = db.transaction(tx => provisionPrincipal(tx, { kind: 'officer', displayName: 'Demo officer',
    workspaceId: provisionWorkspace(tx, { name: 'Synthetic demo' }).id }));
  db.close();
  const peer = '12025550123';
  const config = loadConfig({
    MIRSAD_DATA_DIR: dataDir, MIRSAD_PORT: '0', MIRSAD_DEMO_SEED: 'false', MIRSAD_REVIEWER: 'deterministic',
    WHATSAPP_DEMO_ENABLED: 'true', WHATSAPP_PROVIDER: provider, WHATSAPP_DEMO_TESTERS: '+' + peer, WHATSAPP_DEMO_OFFICER_ID: officer.principal.id,
    WHATSAPP_ACCESS_TOKEN: 'synthetic', WHATSAPP_PHONE_NUMBER_ID: '2222222', WHATSAPP_APP_SECRET: 'synthetic-secret',
    WHATSAPP_VERIFY_TOKEN: 'synthetic-verify', OPENROUTER_API_KEY: 'synthetic-key',
    YCLOUD_WABA_ID: '3333333', YCLOUD_BUSINESS_NUMBER: '+12025550199',
    YCLOUD_API_KEY: 'synthetic-y-key', YCLOUD_WEBHOOK_SECRET: 'synthetic-y-secret',
  });
  const demo = config.whatsappDemo!;
  demo.webhookPort = 0; // Let the OS choose both test ports.
  const sendText = vi.fn(async () => 'wamid.synthetic-reply');
  const generate = vi.fn(async () => 'Hello there!');
  const boot = () => createApp({ config, whatsappSender: { sendText }, replyGenerator: { model: 'fake', generate } });
  const sentAt = new Date();
  const timestamp = String(Math.floor(sentAt.getTime() / 1000));
  const body = demo.provider === 'ycloud' ? JSON.stringify({
    id: 'evt_synthetic', type: 'whatsapp.inbound_message.received', apiVersion: 'v2', createTime: sentAt.toISOString(),
    whatsappInboundMessage: { id: 'provider-id', wamid: 'wamid.synthetic-in', wabaId: demo.wabaId,
      from: '+' + peer, to: demo.businessNumber, type: 'text', text: { body: 'Hello!' }, sendTime: sentAt.toISOString() },
  }) : JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
    value: { messaging_product: 'whatsapp', metadata: { phone_number_id: demo.phoneNumberId },
      messages: [{ type: 'text', id: 'wamid.synthetic-in', from: peer, timestamp,
        text: { body: 'Hello!' } }] } }] }] });
  const webhookHeaders = new Headers({ 'content-type': 'application/json' });
  if (demo.provider === 'ycloud') {
    const signature = createHmac('sha256', demo.webhookSecret).update(timestamp + '.' + body).digest('hex');
    webhookHeaders.set('ycloud-signature', 't=' + timestamp + ',s=' + signature);
  } else {
    webhookHeaders.set('x-hub-signature-256', 'sha256=' + createHmac('sha256', demo.appSecret).update(body).digest('hex'));
  }
  const incoming = (url: string) => fetch(url + '/webhooks/whatsapp', { method: 'POST', body,
    headers: webhookHeaders });
  let app: App | undefined;
  try {
    app = await boot();
    const { url, whatsappWebhookPort } = await app.listen();
    expect(whatsappWebhookPort).toBeGreaterThan(0);
    const callback = 'http://127.0.0.1:' + whatsappWebhookPort;
    expect((await fetch(callback + '/v1/chats')).status).toBe(404);
    expect((await fetch(callback + '/')).status).toBe(404);
    expect((await incoming(url)).ok).toBe(false);
    expect((await incoming(callback)).ok).toBe(true);
    await app.drain();
    expect(generate).not.toHaveBeenCalled();
    const headers = { authorization: 'Bearer ' + officer.token };
    const inbox = await (await fetch(url + '/v1/chats', { headers })).json() as { data: unknown };
    const { chats } = ListChatsResponse.parse(inbox.data);
    expect(chats).toHaveLength(1);
    const chat = chats[0]!;
    expect(chat).toMatchObject({ source: 'whatsapp', aiMode: 'not_started' });
    const result = await fetch(url + '/v1/dispatches', { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'demo-first-dispatch' },
      body: JSON.stringify({ chatIds: [chat.id] }) });
    expect(result.status).toBe(200);
    await app.drain();
    expect(sendText).toHaveBeenCalledExactlyOnceWith(peer, 'Hello there!', 'wamid.synthetic-in');
    const timeline = await (await fetch(url + '/v1/chats/' + chat.id + '/timeline', { headers })).json() as { data: unknown };
    expect(Timeline.parse(timeline.data).messages.map(m => m.direction)).toEqual(['incoming', 'outgoing']);
    await app.close();
    app = undefined;
    app = await boot();
    const restarted = await app.listen();
    expect((await incoming('http://127.0.0.1:' + restarted.whatsappWebhookPort)).ok).toBe(true);
    await app.drain();
    expect(sendText).toHaveBeenCalledTimes(1);
  } finally {
    await app?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
