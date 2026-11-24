/**
 * The all-private chat scope (TELEGRAM_CHAT_SCOPE=all_private, design section 13) and the AI reply worker's automatic
 * start of new chats (TELEGRAM_AI_AUTO_START, design section 20), end to end inside one app with the stand-ins of
 * tests/helpers/telegram-live-harness.ts. The reply worker's own polling is set to an hour, so every reply here comes
 * from a wake. All IDs, names and texts are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TELEGRAM_SERVICE_CHAT_ID } from '../../src/adapters/telegram/chat-scope.ts';
import { REPLY_FRESHNESS_MS } from '../../src/workers/ai-reply-worker.ts';
import { Harness, incoming, LIVE_BASE_ENV, OWNER_ID, standIns, WAIT } from '../helpers/telegram-live-harness.ts';

const EXCLUDED = 6000000299;
const ALL_CHATS_ENV: Record<string, string> = {
  ...LIVE_BASE_ENV,
  TELEGRAM_CHAT_SCOPE: 'all_private',
  TELEGRAM_ALL_CHATS_REFERENCE: 'TEST-ALL-CHATS-0001',
  TELEGRAM_EXCLUDED_CHAT_IDS: String(EXCLUDED),
  TELEGRAM_APPROVED_CHAT_IDS: '6000000201,6000000204,6000000205,6000000206,6000000207,6000000210,6000000211,6000000212,6000000213,6000000214,6000000215,6000000216',
  TELEGRAM_AI_AUTO_START: 'true',
};

describe('all-private intake with replies only in explicitly approved chats', () => {
  const stand = standIns();
  const { sender, generator, clock } = stand;
  let h: Harness;

  beforeAll(async () => {
    h = await Harness.start(ALL_CHATS_ENV, stand);
  });

  afterAll(async () => {
    await h.stop();
  });

  it('answers a listed contact from their first message, and records the automatic start without an officer', async () => {
    const contact = 6000000201;
    const question = await h.receive(contact, 'Hi, is the studio still free?');
    await vi.waitFor(() => expect(sender.to(contact)).toHaveLength(1), WAIT);
    await vi.waitFor(async () => expect(await h.caseActionsOf(contact, 'ai_reply_sent')).toHaveLength(1), WAIT);

    expect((await h.chatFor(contact))?.aiMode).toBe('ai_active');
    const [started] = await h.caseActionsOf(contact, 'ai_auto_started');
    expect(started).toMatchObject({ actor: null, fromMode: 'not_started', toMode: 'ai_active' });
    const [sent] = await h.caseActionsOf(contact, 'ai_reply_sent');
    expect(sent?.detail.inReplyTo).toBe(question.id);
    expect(h.logged('telegram_live_connector_started', '"chatScope":"all_private"')).toBe(true);
    expect(h.logged('telegram_ai_chat_auto_started')).toBe(true);
  });

  it('keeps unlisted chats out of the model, even after an officer dispatches one', async () => {
    const contact = 6000000250;
    const calls = generator.histories.length;
    await h.receive(contact, 'Hello from outside the reply scope');
    clock.advance(3_000);
    await h.app.drain();
    expect((await h.chatFor(contact))?.aiMode).toBe('not_started');
    await h.dispatch(contact);
    await h.app.drain();
    expect(sender.to(contact)).toHaveLength(0);
    expect(generator.histories).toHaveLength(calls);
  });

  it("never stores or answers an excluded chat, Telegram's service chat, the owner's own chat, a bot or a group", async () => {
    const now = clock.now().getTime();
    const chatsBefore = (await h.chats()).length;
    const bot = 6000000202;
    const group = -1000000000301;
    await h.deliver(
      incoming(EXCLUDED, 'An excluded contact writes', now),
      incoming(Number(TELEGRAM_SERVICE_CHAT_ID), 'Login code: 12345', now),
      incoming(OWNER_ID, 'A note to self', now),
      incoming(bot, 'Automated bot message', now, { fromBot: true }),
      incoming(group, 'A group message', now, { chatType: 'group', fromId: 6000000203 }),
    );
    await h.app.drain();

    expect(h.logged('telegram_live_batch', '"updates":5', '"stored":0', '"dropped":5')).toBe(true);
    expect((await h.chats()).length).toBe(chatsBefore);
    for (const id of [EXCLUDED, Number(TELEGRAM_SERVICE_CHAT_ID), OWNER_ID, bot, group]) expect(sender.to(id)).toHaveLength(0);
    expect(h.logs.join('\n')).not.toContain('Login code');
  });

  it('does not start a chat whose first message is a backlog from before the window', async () => {
    const contact = 6000000204;
    await h.receive(contact, 'Sent while Mirsad was down', clock.now().getTime() - REPLY_FRESHNESS_MS - 60_000);
    await h.app.drain();
    expect((await h.chatFor(contact))?.aiMode).toBe('not_started');
    expect(sender.to(contact)).toHaveLength(0);
  });

  it('starts only chats that were never started: a chat an officer paused stays quiet', async () => {
    const contact = 6000000205;
    await h.receive(contact, 'Hello there');
    await vi.waitFor(() => expect(sender.to(contact)).toHaveLength(1), WAIT);
    await h.control(contact, 'pause');
    await h.receive(contact, 'Are you still there?');
    await h.app.drain();

    expect(sender.to(contact)).toHaveLength(1);
    expect((await h.chatFor(contact))?.aiMode).toBe('paused');
    expect(await h.caseActionsOf(contact, 'ai_auto_started')).toHaveLength(1);
  });

  it('discards the pre-pause draft even when the officer resumes before it finishes', async () => {
    const contact = 6000000206;
    const calls = generator.histories.length;
    const draft = 'Draft from before the pause.';
    generator.replyNext(draft);
    generator.holdNext();
    try {
      await h.receive(contact, 'First test message');
      await vi.waitFor(() => expect(generator.histories.length).toBe(calls + 1), WAIT);
      await h.control(contact, 'pause');
      await h.control(contact, 'resume');
    } finally {
      generator.releaseHeld();
    }
    await h.app.drain();

    expect(sender.to(contact).map((s) => s.reply.text)).not.toContain(draft);
    const chat = await h.chatFor(contact);
    expect(h.logged('telegram_ai_reply_discarded', '"reason":"mode_changed"', `"chatId":"${chat?.id}"`)).toBe(true);
    const [pause] = await h.caseActionsOf(contact, 'control_pause');
    const [resume] = await h.caseActionsOf(contact, 'control_resume');
    expect(pause?.actor).toMatchObject({ displayName: 'Officer A' });
    expect(resume?.actor).toEqual(pause?.actor);
  });

  it('keeps chat history out of further model requests after an officer takes over', async () => {
    const contact = 6000000207;
    const calls = generator.histories.length;
    generator.replyNext('https://example.test');
    generator.holdNext();
    try {
      await h.receive(contact, 'Another test message');
      await vi.waitFor(() => expect(generator.histories.length).toBe(calls + 1), WAIT);
      await h.control(contact, 'take_over');
    } finally {
      generator.releaseHeld();
    }
    await h.app.drain();

    expect(generator.histories).toHaveLength(calls + 1);
    expect(sender.to(contact)).toHaveLength(0);
    expect(await h.caseActionsOf(contact, 'ai_reply_failed')).toHaveLength(0);
  });

  it('answers waiting chats in the order their messages arrived', async () => {
    const blocker = 6000000210;
    const waiting = [6000000211, 6000000212, 6000000213, 6000000214, 6000000215];
    const calls = generator.histories.length;
    generator.holdNext();
    await h.receive(blocker, 'Keeping the worker busy');
    await vi.waitFor(() => expect(generator.histories.length).toBe(calls + 1), WAIT);
    for (const [index, contact] of waiting.entries()) await h.receive(contact, `Waiting contact ${index}`);
    generator.releaseHeld();

    await vi.waitFor(() => expect(waiting.every((contact) => sender.to(contact).length === 1)).toBe(true), WAIT);
    const order = sender.sent.map((s) => s.reply.chatId).filter((id) => waiting.includes(id));
    expect(order).toEqual(waiting);
  });
});

describe('all-private scope settings', () => {
  it.each([
    ['the approved list is empty', { TELEGRAM_APPROVED_CHAT_IDS: '' }],
    ['replies are disabled', { TELEGRAM_AI_REPLIES_ENABLED: 'false' }],
  ] as const)('does not reply to messages captured while %s', async (_description, suspension) => {
    const contact = 6000000201;
    const first = standIns();
    let h = await Harness.start(ALL_CHATS_ENV, first);
    try {
      await h.receive(contact, 'First conversation');
      await vi.waitFor(() => expect(first.sender.to(contact)).toHaveLength(1), WAIT);
      await h.close();
      h = await Harness.start({ ...ALL_CHATS_ENV, ...suspension }, standIns(first.clock), h.data);
      await h.receive(contact, 'Message during suspension');
      await h.close();
      const restored = standIns(first.clock);
      h = await Harness.start(ALL_CHATS_ENV, restored, h.data);
      await h.app.drain();
      expect(restored.generator.histories).toHaveLength(0);
      await h.receive(contact, 'Message after restoring replies');
      await vi.waitFor(() => expect(restored.sender.to(contact)).toHaveLength(1), WAIT);
      expect(restored.generator.histories[0]).toEqual([{ from: 'contact', text: 'Message after restoring replies' }]);
    } finally {
      await h.stop();
    }
  });

  it('only uses messages received after a new chat joins the reply list', async () => {
    const contact = 6000000251;
    const first = standIns();
    let h = await Harness.start(ALL_CHATS_ENV, first);
    try {
      await h.receive(contact, 'Captured before enrollment');
      await h.dispatch(contact);
      await h.close();
      const after = standIns(first.clock);
      const expanded = ALL_CHATS_ENV.TELEGRAM_APPROVED_CHAT_IDS + ',' + contact;
      h = await Harness.start({ ...ALL_CHATS_ENV, TELEGRAM_APPROVED_CHAT_IDS: expanded }, after, h.data);
      await h.app.drain();
      expect(after.generator.histories).toHaveLength(0);
      const enrollment = after.clock.now().getTime();
      await h.receive(contact, 'Late delivery from before enrollment', enrollment - 1_000);
      await h.app.drain();
      expect(after.generator.histories).toHaveLength(0);
      await h.receive(contact, 'New message after enrollment', enrollment);
      await vi.waitFor(() => expect(after.sender.to(contact)).toHaveLength(1), WAIT);
      expect(after.generator.histories[0]).toEqual([{ from: 'contact', text: 'New message after enrollment' }]);
    } finally {
      await h.stop();
    }
  });

  it('refuses to start the connector and the replies without TELEGRAM_ALL_CHATS_REFERENCE, and names it', async () => {
    const refused = await Harness.start({ ...ALL_CHATS_ENV, TELEGRAM_ALL_CHATS_REFERENCE: '' }, standIns());
    try {
      expect(refused.logged('telegram_live_connector_refused', 'TELEGRAM_ALL_CHATS_REFERENCE')).toBe(true);
      expect(refused.logged('telegram_ai_replies_refused', 'TELEGRAM_ALL_CHATS_REFERENCE')).toBe(true);
      expect(refused.logged('telegram_live_connector_refused', 'TELEGRAM_APPROVED_CHAT_IDS')).toBe(false);
    } finally {
      await refused.stop();
    }
  });

  it('refuses a TELEGRAM_EXCLUDED_CHAT_IDS that holds anything but chat IDs', async () => {
    const refused = await Harness.start({ ...ALL_CHATS_ENV, TELEGRAM_EXCLUDED_CHAT_IDS: `${EXCLUDED},not-a-chat` }, standIns());
    try {
      expect(refused.logged('telegram_live_connector_refused', 'TELEGRAM_EXCLUDED_CHAT_IDS')).toBe(true);
    } finally {
      await refused.stop();
    }
  });

  it('stores a new chat but waits for Dispatch when auto-start is off', async () => {
    const stand = standIns();
    const h = await Harness.start({ ...ALL_CHATS_ENV, TELEGRAM_AI_AUTO_START: 'false' }, stand);
    try {
      const contact = 6000000216;
      await h.receive(contact, 'Is anyone there?');
      await h.app.drain();
      expect((await h.chatFor(contact))?.aiMode).toBe('not_started');
      expect(stand.sender.to(contact)).toHaveLength(0);

      await h.dispatch(contact);
      await vi.waitFor(() => expect(stand.sender.to(contact)).toHaveLength(1), WAIT);
      expect(await h.caseActionsOf(contact, 'ai_auto_started')).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });

  it('starts approved chats automatically in the approved scope, and still drops every other chat', async () => {
    const stand = standIns();
    const approved = 6000000220;
    const other = 6000000221;
    const h = await Harness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(approved), TELEGRAM_AI_AUTO_START: 'true' }, stand);
    try {
      await h.receive(approved, 'Hello from the approved chat');
      await vi.waitFor(() => expect(stand.sender.to(approved)).toHaveLength(1), WAIT);

      await h.deliver(incoming(other, 'Hello from a chat on no list', stand.clock.now().getTime()));
      await h.app.drain();
      expect(await h.chatFor(other)).toBeUndefined();
      expect(stand.sender.to(other)).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });
});
