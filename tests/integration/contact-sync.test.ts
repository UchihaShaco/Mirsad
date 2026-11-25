/**
 * Contact sync: a flagged number goes to the contact-sync server as active, a withdrawn flag deactivates it, a server
 * that is down gets the number later, and a restart sends the flagged set once more. A fake server on loopback records
 * every request. Reserved fictional numbers and invented text only.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.ts';
import { envelope, recorded, uniqueId } from '../helpers/events.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

interface Received {
  method: string;
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

/** A stand-in for the contact-sync server's admin API: records requests and answers with `status`. */
class FakeSyncServer {
  readonly received: Received[] = [];
  status = 200;
  private server: http.Server | null = null;
  port = 0;

  async start(port = 0): Promise<void> {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        this.received.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization ?? null, body: raw ? JSON.parse(raw) : {} });
        res.writeHead(this.status, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}

const sync = new FakeSyncServer();
let h: TestHarness;
const syncConfig = (token: string | null): Config['contactSync'] => ({ url: sync.url, token, label: 'Flagged on the Mirsad portal', source: 'mirsad-portal' });

beforeAll(async () => {
  await sync.start();
  h = await startHarness({ config: { contactSync: syncConfig('sync-admin-token-test') } });
});
afterAll(async () => {
  await h.close();
  await sync.stop();
});
afterEach(() => { sync.received.length = 0; sync.status = 200; });

const officerA = () => h.http(h.tokens.officerA);
async function inboundChat(text: string): Promise<string> {
  const res = await h.http(h.tokens.connector).post('/v1/ingest', envelope(h.accounts.intake, uniqueId('sync-'), recorded({ messageId: 1, text })));
  expect(res.status, res.text).toBe(201);
  return res.body.data.chatId as string;
}
const flag = (chatId: string, phone: string) => officerA().post(`/v1/chats/${chatId}/scammer-flags`, { phone, reason: 'Asked for an upfront fee.' });
const entryFor = async (e164: string) =>
  (await officerA().get('/v1/watchlist')).body.data.entries.find((e: { number: { e164: string } }) => e.number.e164 === e164);

describe('contact sync', () => {
  it('publishes a flagged number with the token, a fixed label and the entry reference, and deactivates it when cleared', async () => {
    const chatId = await inboundChat('Pay the customs fee to release your parcel.');
    const flagged = await flag(chatId, '+44 7700 900311');
    expect(flagged.status, flagged.text).toBe(201);
    expect(flagged.body.data.entry.contactSync).toEqual({ state: 'queued', label: 'Queued' });
    await h.drain();

    const entry = await entryFor('+447700900311');
    expect(sync.received).toEqual([{
      method: 'POST', path: '/api/v1/scammers', authorization: 'Bearer sync-admin-token-test',
      body: { phone: '+447700900311', active: true, label: 'Flagged on the Mirsad portal', source: 'mirsad-portal', note: `Mirsad watchlist entry ${entry.id}` },
    }]);
    expect(JSON.stringify(sync.received)).not.toMatch(/customs|Asked for/);
    expect(entry.contactSync).toEqual({ state: 'on_phones', label: 'On phones' });

    // Flagging the same number again is idempotent: the server already holds it.
    expect((await flag(chatId, '+447700900311')).status).toBe(200);
    await h.drain();
    expect(sync.received).toHaveLength(1);

    const cleared = await officerA().post(`/v1/watchlist/${entry.id}/review`, { decision: 'clear', reason: 'Wrong number entered.', expectedRevision: entry.revision });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.data.entry.contactSync).toBeNull();
    await h.drain();
    expect(sync.received[1]).toEqual({ method: 'PATCH', path: '/api/v1/scammers/%2B447700900311', authorization: 'Bearer sync-admin-token-test', body: { active: false } });
    expect(h.logs.join('\n')).not.toMatch(/900311|sync-admin-token-test/);
  });

  it('queues a flag while the server is down and delivers it on a later retry', async () => {
    const port = sync.port;
    await sync.stop();
    const chatId = await inboundChat('Send the deposit by bank transfer.');
    expect((await flag(chatId, '+1 202 555 0142')).status).toBe(201);
    await h.drain();
    expect((await entryFor('+12025550142')).contactSync).toEqual({ state: 'queued', label: 'Queued' });

    await sync.start(port);
    h.clock.advance(2000);
    await h.drain();
    expect(sync.received.map((r) => [r.method, r.body.phone])).toEqual([['POST', '+12025550142']]);
    expect((await entryFor('+12025550142')).contactSync).toEqual({ state: 'on_phones', label: 'On phones' });
  });

  it('stops after a refusal and names it, and sends the flagged set once more after a restart', async () => {
    sync.status = 422;
    const chatId = await inboundChat('Your account is locked, call this number.');
    expect((await flag(chatId, '+44 7700 900312')).status).toBe(201);
    await h.drain();
    h.clock.advance(60_000);
    await h.drain();
    expect(sync.received).toHaveLength(1);
    expect((await entryFor('+447700900312')).contactSync).toEqual({ state: 'not_sent', label: 'Not sent: number refused' });

    sync.status = 200;
    sync.received.length = 0;
    await h.restart();
    await h.drain();
    expect(sync.received.map((r) => [r.method, r.body.phone ?? r.path]).sort()).toEqual([
      ['POST', '+12025550142'], ['POST', '+447700900312'],
    ]);
    expect(h.logs.some((line) => line.includes('"contact_sync_reconciled"'))).toBe(true);
  });
});

describe('contact sync turned off', () => {
  it('sends nothing and shows no state', async () => {
    const off = await startHarness();
    try {
      const res = await off.http(off.tokens.connector).post('/v1/ingest', envelope(off.accounts.intake, uniqueId('off-'), recorded({ messageId: 1, text: 'Pay now.' })));
      const flagged = await off.http(off.tokens.officerA).post(`/v1/chats/${res.body.data.chatId}/scammer-flags`, { phone: '+44 7700 900313', reason: 'Asked for an upfront fee.' });
      expect(flagged.status, flagged.text).toBe(201);
      expect(flagged.body.data.entry.contactSync).toBeNull();
      await off.drain();
      expect(sync.received).toEqual([]);
    } finally {
      await off.close();
    }
  });
});
