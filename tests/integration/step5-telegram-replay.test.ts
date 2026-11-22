import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replayFixture, type ReplayOptions } from '../../src/adapters/replay.ts';
import type { TelegramFixture } from '../../src/adapters/telegram/types.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/telegram');
const loadFixture = (name: string): TelegramFixture =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as TelegramFixture;

let h: TestHarness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const options = (over: Partial<ReplayOptions> = {}): ReplayOptions => ({
  baseUrl: h.baseUrl,
  connectorToken: h.tokens.connector,
  accounts: { intake: 'tg-intake-1', officer: 'tg-officer-1' },
  ...over,
});

async function chatsFor(externalChatId: string, externalAccountId: string) {
  const res = await h.http(h.tokens.officerA).get('/v1/chats?limit=500');
  expect(res.status).toBe(200);
  return (res.body.data.chats as any[]).filter((c) => c.externalChatId === externalChatId && c.externalAccountId === externalAccountId);
}

async function timelineOf(chatId: string) {
  const res = await h.http(h.tokens.officerA).get(`/v1/chats/${chatId}/timeline`);
  expect(res.status).toBe(200);
  return res.body.data;
}

describe('step 5: telegram replay', () => {
  it('replaying inbound-first creates a New inbound chat labelled First observed: incoming', async () => {
    const report = await replayFixture(loadFixture('inbound-first-greeting'), options());
    expect(report.events.map((e) => [e.status, e.result])).toEqual([[201, 'recorded']]);
    const [chat] = await chatsFor('6000000001', 'tg-intake-1');
    expect(chat).toMatchObject({ inboxStatus: 'new_inbound', originLabel: 'First observed: incoming', firstObservedDirection: 'incoming' });
  });

  it('replaying officer-first creates an open chat labelled First observed: outgoing with both directions', async () => {
    await replayFixture(loadFixture('officer-first'), options());
    const [chat] = await chatsFor('6000000002', 'tg-officer-1');
    expect(chat).toMatchObject({ inboxStatus: 'open', originLabel: 'First observed: outgoing', displayLabel: 'Test Contact 2' });
    const timeline = await timelineOf(chat.id);
    expect(timeline.messages.map((m: any) => m.direction)).toEqual(['outgoing', 'incoming']);
  });

  it('a fixture start assertion yields Contact started chat', async () => {
    const fixture = { ...loadFixture('inbound-first-greeting'), conversationStarts: [{ chatId: 6000000001, messageId: 4101 }] };
    const marked = {
      ...fixture,
      updates: fixture.updates.map((u) => ({
        ...u,
        business_message: u.business_message && { ...u.business_message, chat: { ...u.business_message.chat, id: 6000000011 }, from: u.business_message.from && { ...u.business_message.from, id: 6000000011 } },
      })),
      conversationStarts: [{ chatId: 6000000011, messageId: 4101 }],
    };
    const report = await replayFixture(marked, options());
    expect(report.events[0]?.status).toBe(201);
    const [chat] = await chatsFor('6000000011', 'tg-intake-1');
    expect(chat).toMatchObject({ originLabel: 'Contact started chat', initiatedBy: 'contact', initiationBasis: 'source_start_marker' });
  });

  it('replaying a fixture twice creates no duplicate chat, message or capture', async () => {
    const fixture = loadFixture('takeover-pair');
    await replayFixture(fixture, options());
    const snapshot = async () => {
      const chats = await chatsFor('6000000007', 'tg-intake-1');
      expect(chats).toHaveLength(1);
      const timeline = await timelineOf(chats[0].id);
      return timeline.messages.map((m: any) => [m.id, m.capture?.id ?? null]);
    };
    const before = await snapshot();
    const again = await replayFixture(fixture, options());
    expect(again.events.every((e) => e.status === 200 && e.result === 'duplicate_event')).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(before).toHaveLength(3);
    expect(before.every(([, capture]: [string, string | null]) => capture !== null)).toBe(true);
  });

  it('edits and deletions from the fixture are separate events and the original stays', async () => {
    const report = await replayFixture(loadFixture('edit-and-delete'), options());
    expect(report.events.map((e) => e.result)).toEqual(['recorded', 'recorded', 'recorded', 'duplicate_event']);
    const [chat] = await chatsFor('6000000003', 'tg-intake-1');
    const timeline = await timelineOf(chat.id);
    expect(timeline.messages).toHaveLength(1);
    expect(timeline.messages[0]).toMatchObject({ text: 'See you at five.', editedAtSource: true, deletedAtSource: true, originalCaptured: true });
    expect(timeline.messageEvents.map((e: any) => [e.type, e.text])).toEqual([
      ['edited', 'See you at six.'],
      ['deleted', null],
    ]);
  });

  it('a chat first seen through a deletion or an edit is labelled with the contact name', async () => {
    const base = loadFixture('edit-and-delete');
    const contact = (id: number) => ({ id, type: 'private', first_name: 'Test', last_name: `Contact ${id % 100}` });
    const midChat: TelegramFixture = {
      ...base,
      updates: [
        {
          update_id: 920_000_001,
          deleted_business_messages: { business_connection_id: base.businessConnectionId, chat: contact(6000000031), message_ids: [5101] },
        },
        {
          update_id: 920_000_002,
          edited_business_message: {
            message_id: 5201,
            date: 1790000300,
            edit_date: 1790000360,
            chat: contact(6000000032),
            from: { ...contact(6000000032), is_bot: false },
            business_connection_id: base.businessConnectionId,
            text: 'Edited before Mirsad saw the original.',
          },
        },
      ],
    };
    const report = await replayFixture(midChat, options());
    expect(report.events.map((e) => e.status)).toEqual([201, 201]);
    const [deletedFirst] = await chatsFor('6000000031', 'tg-intake-1');
    const [editedFirst] = await chatsFor('6000000032', 'tg-intake-1');
    expect([deletedFirst?.displayLabel, editedFirst?.displayLabel]).toEqual(['Test Contact 31', 'Test Contact 32']);
  });

  it('a hidden link, a forward and content of an unknown kind are listed as not captured, and each message gets a capture', async () => {
    const base = loadFixture('inbound-first-greeting');
    const chat = { id: 6000000041, type: 'private', first_name: 'Test', last_name: 'Contact 41' };
    const from = { ...chat, is_bot: false };
    const at = (messageId: number, extra: Record<string, unknown>) => ({
      update_id: 920_000_000 + messageId,
      business_message: { message_id: messageId, date: 1790000400 + messageId, chat, from, business_connection_id: base.businessConnectionId, ...extra },
    });
    const fixture = {
      ...base,
      updates: [
        at(5301, {
          text: 'Please settle the invoice here',
          entities: [{ type: 'text_link', offset: 26, length: 4, url: 'https://pay.other-host.test/invoice/9' }],
        }),
        at(5302, { text: 'Passing this on.', forward_origin: { type: 'hidden_user', date: 1790000400, sender_user_name: 'Someone' } }),
        at(5303, { dice: { value: 4 } }),
      ],
    } as TelegramFixture;
    const report = await replayFixture(fixture, options());
    expect(report.events.map((e) => e.status)).toEqual([201, 201, 201]);
    await h.drain();
    const [stored] = await chatsFor('6000000041', 'tg-intake-1');
    const timeline = await timelineOf(stored.id);
    expect(timeline.messages.map((m: any) => [m.text, m.unsupportedContent, m.capture?.status ?? null])).toEqual([
      ['Please settle the invoice here', ['text_link'], 'ready'],
      ['Passing this on.', ['forwarded'], 'ready'],
      ['', ['other'], 'ready'],
    ]);
    expect(JSON.stringify(timeline)).not.toContain('pay.other-host.test');
  });

  it('the replay report contains ids and result codes but no message text', async () => {
    const fixture = loadFixture('payment-destination-change');
    const report = await replayFixture(fixture, options());
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('pay.alt-shop.test');
    expect(serialized).not.toContain('Thursday');
    expect(serialized).not.toContain('Test Contact');
    for (const event of report.events) {
      expect(Object.keys(event).sort()).toEqual(['chatId', 'messageId', 'result', 'sourceEventId', 'status']);
    }
    expect(report.events).toHaveLength(6);
  });

  it('replay refuses a file that is not marked synthetic or that holds a non-reserved domain or phone number', async () => {
    const calls: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      calls.push(String(input));
      return fetch(input, init);
    };
    const base = loadFixture('inbound-first-greeting');
    const withText = (text: string): TelegramFixture => ({
      ...base,
      updates: base.updates.map((u) => ({ ...u, business_message: u.business_message && { ...u.business_message, text } })),
    });
    const notSynthetic = { ...base, synthetic: false } as unknown as TelegramFixture;
    await expect(replayFixture(notSynthetic, options({ fetch: spy }))).rejects.toThrow(/synthetic/);
    await expect(replayFixture(withText('pay at https://pay.real-bank.com/x'), options({ fetch: spy }))).rejects.toThrow(/domain/);
    await expect(replayFixture(withText('call +1 415 555 0223'), options({ fetch: spy }))).rejects.toThrow(/phone/);
    expect(calls).toEqual([]);
  });

  it("the fixture account is mapped to the caller's account ID", async () => {
    const bodies: { externalAccountId: string; source: string }[] = [];
    const spy: typeof fetch = async (input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${h.tokens.connector}`);
      return fetch(input, init);
    };
    const fixture = { ...loadFixture('merchant-conflict') };
    await replayFixture(fixture, options({ fetch: spy, accounts: { intake: 'tg-intake-1', officer: 'tg-live-1' } }));
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => b.externalAccountId === 'tg-intake-1' && b.source === 'telegram')).toBe(true);
    expect(await chatsFor('6000000009', 'tg-intake-1')).toHaveLength(1);
  });
  it('replay refuses a structurally invalid fixture before any request is made', async () => {
    const calls: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      calls.push(String(input));
      return fetch(input, init);
    };
    const base = loadFixture('inbound-first-greeting');
    const [first] = base.updates;
    const { message_id: _omit, ...noId } = first?.business_message ?? ({} as never);
    const missingId = { ...base, updates: [{ ...first, business_message: noId }] };
    const badStarts = { ...base, conversationStarts: 'nope' };
    await expect(replayFixture(missingId as never, options({ fetch: spy }))).rejects.toThrow(/message_id/);
    await expect(replayFixture(badStarts as never, options({ fetch: spy }))).rejects.toThrow(/conversationStarts/);
    expect(calls).toEqual([]);
  });
});
