/**
 * The shared channel contract (brief step 5): every channel's fixtures must pass the same inbox, evidence, watchlist
 * hook and takeover checks, through the HTTP API only. Telegram is the one channel.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replayFixture, type ReplayReport } from '../../src/adapters/replay.ts';
import type { ChatSummary, Timeline, WatchlistEntry } from '../../src/contract/schemas.ts';
import { recorded, uniqueId } from '../helpers/events.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

/** What a channel supplies: its labels and five scenario fixtures, replayed through the common intake API. */
interface ChannelCase {
  source: 'telegram';
  channelLabel: 'Telegram';
  /** A number that the phone-mention scenario ties to a concern and the sender scenario shares as sender metadata. */
  watchedNumber: string;
  replay: {
    /** A contact's first message in a new chat. */
    inboundFirst(h: TestHarness): Promise<ReplayReport>;
    /** The account owner writes first and the contact replies. */
    officerFirst(h: TestHarness): Promise<ReplayReport>;
    /** A chat with several incoming messages. */
    conversation(h: TestHarness): Promise<ReplayReport>;
    /** A message that mentions the watched number with a payment or call-back request. */
    phoneMention(h: TestHarness): Promise<ReplayReport>;
    /** A new inbound chat whose sender shares the watched number as their own. */
    senderWithWatchedNumber(h: TestHarness): Promise<ReplayReport>;
  };
}

const TELEGRAM_FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/telegram');
const FIXTURE_ACCOUNTS = { intake: 'tg-intake-1', officer: 'tg-officer-1' } as const;
const DECISION_REASON = 'Checked against the cited evidence in the case file.';

function telegramReplay(name: string, from = 0, to?: number) {
  return (h: TestHarness): Promise<ReplayReport> => {
    const fixture = JSON.parse(fs.readFileSync(path.join(TELEGRAM_FIXTURES, `${name}.json`), 'utf8')) as { updates: unknown[] };
    const slice = { ...fixture, updates: fixture.updates.slice(from, to) };
    return replayFixture(slice, { baseUrl: h.baseUrl, connectorToken: h.tokens.connector, accounts: FIXTURE_ACCOUNTS });
  };
}

const telegram: ChannelCase = {
  source: 'telegram',
  channelLabel: 'Telegram',
  watchedNumber: '+447700900123',
  replay: {
    inboundFirst: telegramReplay('inbound-first-greeting'),
    officerFirst: telegramReplay('officer-first'),
    conversation: telegramReplay('takeover-pair'),
    phoneMention: telegramReplay('watchlist-sequence', 0, 1),
    senderWithWatchedNumber: telegramReplay('watchlist-sequence', 1),
  },
};

function firstChatId(report: ReplayReport): string {
  const chatId = report.events.find((e) => e.chatId !== null)?.chatId;
  if (!chatId) throw new Error('the scenario stored no chat');
  return chatId;
}

function channelContract(channel: ChannelCase): void {
  let h: TestHarness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const officer = () => h.http(h.tokens.officerA);
  const timeline = async (chatId: string): Promise<Timeline> => {
    const res = await officer().get(`/v1/chats/${chatId}/timeline`);
    expect(res.status, res.text).toBe(200);
    return res.body.data as Timeline;
  };
  const chats = async (query = ''): Promise<ChatSummary[]> => (await officer().get(`/v1/chats?limit=500${query}`)).body.data.chats as ChatSummary[];
  const dispatch = async (chatIds: string[]) => {
    const res = await officer().post('/v1/dispatches', { chatIds }, { 'Idempotency-Key': uniqueId('contract-') });
    expect(res.status, res.text).toBe(200);
  };

  it('inbox: a contact-first chat enters New inbound and an officer-first chat opens with both directions', async () => {
    const inbound = firstChatId(await channel.replay.inboundFirst(h));
    const queued = (await chats('&inboxStatus=new_inbound')).find((c) => c.id === inbound);
    expect(queued).toMatchObject({ source: channel.source, channelLabel: channel.channelLabel, inboxStatus: 'new_inbound', originLabel: 'First observed: incoming' });

    const officerFirst = firstChatId(await channel.replay.officerFirst(h));
    const opened = await timeline(officerFirst);
    expect(opened.chat).toMatchObject({ inboxStatus: 'open', originLabel: 'First observed: outgoing', channelLabel: channel.channelLabel });
    expect(opened.messages.map((m) => m.direction)).toEqual(expect.arrayContaining(['outgoing', 'incoming']));
  });

  it('evidence: every received message is stored with its own Mirsad-rendered capture the officer can fetch', async () => {
    const report = await channel.replay.conversation(h);
    await h.drain();
    const chatIds = [...new Set(report.events.map((e) => e.chatId).filter((id): id is string => id !== null))];
    const messages = (await Promise.all(chatIds.map(timeline))).flatMap((t) => t.messages);
    expect(messages.length).toBe(report.events.length);
    for (const message of messages) {
      expect(message.source).toMatchObject({ channel: channel.source, captureMethod: 'fixture_replay' });
      expect(message.capture).toMatchObject({ kind: 'mirsad_rendered_capture', status: 'ready' });
      const res = await fetch(`${h.baseUrl}/v1/artifacts/${message.capture?.artifactId ?? ''}`, { headers: { authorization: `Bearer ${h.tokens.officerA}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      const sha256 = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
      expect(sha256).toBe(message.capture?.sha256);
    }
    expect(new Set(messages.map((m) => m.capture?.artifactId)).size).toBe(messages.length);
  });

  it('watchlist hook: a number in the evidence reaches the Phone watchlist and an approved entry matches a new inbound sender', async () => {
    const mentionChat = firstChatId(await channel.replay.phoneMention(h));
    await dispatch([mentionChat]);
    await h.drain();
    const entries = (await officer().get('/v1/watchlist')).body.data.entries as WatchlistEntry[];
    const entry = entries.find((e) => e.number.e164 === channel.watchedNumber);
    expect(entry).toMatchObject({ status: 'needs_review', statusLabel: 'Needs review' });
    expect(entry?.evidence).toEqual([expect.objectContaining({ chatId: mentionChat, origin: 'message_mention' })]);

    const approved = await officer().post(`/v1/watchlist/${entry?.id ?? ''}/review`, { decision: 'approve', reason: DECISION_REASON, expectedRevision: entry?.revision });
    expect(approved.status, approved.text).toBe(200);
    const senderChat = firstChatId(await channel.replay.senderWithWatchedNumber(h));
    const summary = (await timeline(senderChat)).chat;
    expect(summary.inboxStatus).toBe('new_inbound');
    expect(summary.watchlistMatches).toEqual([expect.objectContaining({ entryId: entry?.id })]);
  });

  it('takeover: the controlling officer replies as Simulated send or leaves a message unanswered while capture continues', async () => {
    const chatId = firstChatId(await channel.replay.conversation(h));
    const start = await timeline(chatId);
    const taken = await officer().post(`/v1/chats/${chatId}/control`, { action: 'take_over', expectedRevision: start.chat.revision });
    expect(taken.status, taken.text).toBe(200);
    const revision = taken.body.data.chat.revision as number;
    const reply = await officer().post(`/v1/chats/${chatId}/officer-messages`, { text: 'Message received.', expectedRevision: revision }, { 'Idempotency-Key': uniqueId('contract-reply-') });
    expect(reply.status, reply.text).toBe(201);
    const incoming = start.messages.filter((m) => m.direction === 'incoming').at(-1);
    const left = await officer().post(`/v1/chats/${chatId}/officer-decisions`, { decision: 'leave_unanswered', messageId: incoming?.id, expectedRevision: revision });
    expect(left.status, left.text).toBe(201);

    const later = await h.http(h.tokens.connector).post(`/v1/chats/${chatId}/events`, recorded({ messageId: 9001, text: 'Are you still there?' }));
    expect(later.status, later.text).toBe(201);
    await h.drain();
    const after = await timeline(chatId);
    expect(after.chat.aiMode).toBe('officer_control');
    expect(after.messages.filter((m) => m.origin === 'officer_composer').map((m) => m.sendStatusLabel)).toEqual(['Simulated send']);
    expect(after.caseActions.map((a) => a.type)).toContain('leave_unanswered');
    expect(after.messages.find((m) => m.id === later.body.data.messageId)?.capture?.status).toBe('ready');
  });
}

describe('the shared channel contract passes for Telegram fixtures', () => {
  channelContract(telegram);
});
