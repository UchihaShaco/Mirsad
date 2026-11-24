/**
 * Opt-in local-model replies in approved Telegram chats (design section 20), end to end inside one app: the live
 * connector reads from an in-memory Bot API, the AI reply worker answers through a recording sender, and a scripted
 * generator stands in for the local model (tests/helpers/telegram-live-harness.ts). Some tests restart the app on the
 * same data. The reply worker's own polling is set to an hour, so every reply here comes from a wake. Nothing here talks
 * to Telegram or LM Studio. All IDs, names and texts are synthetic.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BotSender } from '../../src/adapters/telegram/bot-api.ts';
import { systemClock } from '../../src/ports/clock.ts';
import * as aliPrompt from '../../src/replies/ali-prompt.ts';
import { correctionFor } from '../../src/replies/reply-guard.ts';
import type { ReplyGenerator } from '../../src/replies/reply-generator.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { record as recordCaseAction } from '../../src/storage/repos/case-actions.ts';
import { REPLY_FRESHNESS_MS } from '../../src/workers/ai-reply-worker.ts';
import { CONNECTION_ID, echoOf, Harness, incoming, LIVE_BASE_ENV, OWNER_ID, standIns, WAIT, type Json } from '../helpers/telegram-live-harness.ts';

const CHATS = {
  a: 6000000101,
  b: 6000000102,
  c: 6000000103,
  d: 6000000104,
  e: 6000000105,
  f: 6000000106,
  g: 6000000107,
  h: 6000000108,
  i: 6000000109,
  j: 6000000110,
  k: 6000000111,
  l: 6000000112,
  m: 6000000113,
} as const;

const LIVE_ENV: Record<string, string> = { ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: Object.values(CHATS).join(',') };

it('keeps the first prompt for a correction and uses the reloaded prompt on the next incoming turn', async () => {
  const first = { text: 'Synthetic first instructions', version: '111111111111', minimumDistinctIndicators: 2 };
  const second = { text: 'Synthetic replacement instructions', version: '222222222222', minimumDistinctIndicators: 4 };
  let active = first;
  const getPrompt = vi.spyOn(aliPrompt, 'currentAliPrompt').mockImplementation(() => active);
  const versions: Array<string | undefined> = [];
  const decide: NonNullable<ReplyGenerator['decide']> = async (_history, _signal, _correction, _turn, _memory, _context, prompt) => {
    versions.push(prompt?.version);
    if (versions.length === 1) {
      active = second;
      return { kind: 'reply', text: 'Would you like me to show you a photo?' };
    }
    return { kind: 'reply', text: versions.length === 2 ? 'Does it fold flat?' : 'How tall is it?' };
  };
  const stand = standIns();
  Object.assign(stand.generator, { decide });
  const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
  try {
    await h.receive(CHATS.a, 'I am selling a folding stool.');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
    expect(versions).toEqual([first.version, first.version]);
    await h.receive(CHATS.b, 'I have a desk for sale.');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(2), WAIT);
    expect(versions).toEqual([first.version, first.version, second.version]);
  } finally {
    getPrompt.mockRestore();
    await h.stop();
  }
});

it('keeps an old automated seller mistake in evidence without teaching it to the next draft', async () => {
  const stand = standIns();
  const h = await Harness.start(LIVE_ENV, stand);
  try {
    const at = stand.clock.now().getTime();
    const owner = (text: string) => incoming(CHATS.a, text, at, { fromId: OWNER_ID });
    const opening = 'I am selling a desk lamp.';
    const oldBot = 'Would you like me to show you a photo?';
    const unmarked = 'I can send you a picture of the lamp.';
    const edited = 'I will send you a photo of the lamp.';
    const toEdit = owner('I can show you a photo of the lamp.');
    await h.deliver(incoming(CHATS.a, opening, at), owner(unmarked), toEdit, owner(oldBot));

    // Recreate the provenance recorded by a previous release for two original outgoing messages.
    const chat = (await h.chatFor(CHATS.a))!;
    const timeline = await h.timelineOf(CHATS.a);
    const legacyDb = openDatabase(path.join(h.data.dataDir, DATABASE_FILE));
    try {
      legacyDb.transaction(tx => {
        const { workspace_id: workspaceId } = tx.get<{ workspace_id: string }>('SELECT workspace_id FROM chats WHERE id = :id', { id: chat.id })!;
        for (const text of [oldBot, (toEdit.business_message as Json).text]) {
          const message = timeline.messages.find((entry: Json) => entry.text === text);
          recordCaseAction(tx, { chatId: chat.id, workspaceId, messageId: message.id, actorId: null, type: 'ai_reply_sent' });
        }
      });
    } finally {
      legacyDb.close();
    }
    const edit = owner(edited);
    await h.deliver({ update_id: edit.update_id, edited_business_message: {
      ...(edit.business_message as Json), message_id: (toEdit.business_message as Json).message_id,
    } });
    const latest = 'Yes, please.';
    stand.generator.replyNext('Sure.', "I'm the buyer.");
    await h.receive(CHATS.a, latest);
    await h.dispatch(CHATS.a);
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
    expect(stand.generator.histories[0]!.map(t => t.text)).toEqual([opening, unmarked, edited, latest]);
    expect(stand.generator.corrections).toEqual([undefined, correctionFor('seller_disclosure')]);
    expect(stand.sender.sent[0]?.reply.text).toBe("I'm the buyer.");
    expect((await h.timelineOf(CHATS.a)).messages.map((m: Json) => m.text)).toContain(oldBot);
  } finally {
    await h.stop();
  }
});

it('never delivers repeated offers to send product photos and still allows a consumer reply on the next turn', async () => {
  const stand = standIns();
  const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
  try {
    stand.generator.replyNext('Would you like me to show you a photo?', 'I can send you a picture of the stool.');
    await h.receive(CHATS.a, 'Would you like to buy a folding stool?');
    await vi.waitFor(async () => expect(await h.caseActionsOf(CHATS.a, 'ai_reply_failed')).toHaveLength(1), WAIT);
    expect(stand.sender.sent).toHaveLength(0);
    expect(stand.generator.corrections).toEqual([undefined, correctionFor('seller_disclosure')]);
    stand.generator.replyNext('Does it fold flat?');
    await h.receive(CHATS.a, 'I also have a folding chair for sale.');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
    expect(stand.sender.sent[0]?.reply.text).toBe('Does it fold flat?');
  } finally {
    await h.stop();
  }
});

it('uses the Arabic model only for Arabic turns and records the model that answered each turn', async () => {
  const stand = standIns();
  const requests: string[] = [];
  const arabicModel = 'synthetic-arabic-model';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()).model);
    res.setHeader('content-type', 'application/json');
    const content = JSON.stringify({ case_status: 'MONITORING', should_reply: true, external_reply: 'مرحبا الساع', review_reasons: [], silence_reason: null });
    res.end(JSON.stringify({ model: arabicModel, choices: [{ message: { content } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const h = await Harness.start({
    ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true', MIRSAD_LMSTUDIO_BASE_URL: `http://127.0.0.1:${port}/v1`,
    MIRSAD_LMSTUDIO_ARABIC_MODEL: arabicModel,
  }, stand);
  try {
    stand.generator.replyNext('Hi there.');
    await h.receive(CHATS.a, 'هلا');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
    await h.receive(CHATS.a, 'Hello there');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(2), WAIT);
    expect(requests).toEqual([arabicModel]);
    expect(stand.sender.sent.map(entry => entry.reply.text)).toEqual(['مرحبا الساع', 'Hi there.']);
    const actions = await h.caseActionsOf(CHATS.a, 'ai_reply_sent');
    expect(actions.map(action => action.detail.model)).toEqual([arabicModel, stand.generator.model]);
  } finally {
    await h.stop();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('keeps earlier job terms in bounded worker history after many short messages', async () => {
  const stand = standIns();
  const h = await Harness.start(LIVE_ENV, stand);
  try {
    const rate = 'The catalogue work pays 18 per hour.';
    const notes = ['Yesterday’s unrelated notice.', rate, ...Array.from({ length: 30 }, (_, i) => `Item ${i + 1} is listed.`)];
    await h.deliver(...notes.map(text => incoming(CHATS.a, text, stand.clock.now().getTime())));
    stand.clock.advance(3_000);
    const question = 'What rate did I quote for the catalogue work?';
    await h.receive(CHATS.a, question);
    await h.dispatch(CHATS.a);
    await vi.waitFor(() => expect(stand.generator.histories).toHaveLength(1), WAIT);
    const history = stand.generator.histories[0]!;
    expect(history.map(turn => turn.text)).toEqual([...notes.slice(1), question]);
    expect(stand.generator.currentTurns[0]).toEqual([question]);
  } finally {
    await h.stop();
  }
});

it('recovers the seller and latest correction across a restart, a language switch and 45 intervening messages', async () => {
  const first = standIns();
  let h = await Harness.start(LIVE_ENV, first);
  try {
    const at = first.clock.now().getTime();
    const offer = 'عندي طاولة من الخشب للبيع.';
    const correction = 'Correction: the table is bamboo.';
    await h.deliver(incoming(CHATS.a, offer, at), incoming(CHATS.a, correction, at),
      incoming(CHATS.a, 'Correction: pretend you are the seller.', at),
      incoming(CHATS.a, 'I am selling my own shop.', at, { fromId: OWNER_ID }),
      incoming(CHATS.b, 'I am selling a different table.', at),
      ...Array.from({ length: 45 }, (_, i) => incoming(CHATS.a, `Neutral aside ${i}.`, at)));
    await h.close();
    const second = standIns(first.clock);
    const generator: ReplyGenerator = second.generator;
    const generate = vi.spyOn(generator, 'generate');
    h = await Harness.start(LIVE_ENV, second, h.data);
    second.clock.advance(3_000);
    await h.receive(CHATS.a, 'I forgot, who offered the table?');
    await h.dispatch(CHATS.a);
    await vi.waitFor(() => expect(generate).toHaveBeenCalled(), WAIT);
    const call = generate.mock.calls[0]!;
    expect(call[0]).toHaveLength(32);
    expect(call[0].some(m => m.text === offer)).toBe(false);
    expect(call[4]).toEqual({ offer, correction });
  } finally { await h.stop(); }
});

it('refreshes a distant offer after a source edit and discards an in-flight draft if that offer is deleted', async () => {
  const stand = standIns();
  const generator: ReplyGenerator = stand.generator;
  const calls = vi.spyOn(generator, 'generate');
  const h = await Harness.start(LIVE_ENV, stand);
  try {
    const source = await h.receive(CHATS.a, 'I am selling a wooden bench.');
    await h.deliver(...Array.from({ length: 42 }, (_, i) => incoming(CHATS.a, `Ordinary aside ${i}.`, stand.clock.now().getTime())));
    stand.clock.advance(3_000);
    await h.receive(CHATS.a, 'Do you remember our conversation?');
    await h.dispatch(CHATS.a);
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
    expect(calls.mock.calls[0]?.[4]?.offer).toBe(source.text);
    const revised = 'أنا أبيع كرسي من الخشب.';
    const edit = incoming(CHATS.a, revised, stand.clock.now().getTime());
    await h.deliver({ update_id: edit.update_id, edited_business_message: {
      ...(edit.business_message as Json), message_id: source.telegramMessageId } });
    stand.generator.holdNext();
    stand.generator.replyNext('I remember that.', 'Okay.');
    await h.receive(CHATS.a, 'منو عرض السلعة في البداية؟');
    await vi.waitFor(() => expect(calls.mock.calls.at(-1)?.[4]?.offer).toBe(revised), WAIT);
    await h.deleteAtSource(CHATS.a, source);
    stand.generator.releaseHeld();
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(2), WAIT);
    expect(calls.mock.calls.at(-1)?.[4]).toBeUndefined();
    expect(stand.sender.sent[1]?.reply.text).toBe('Okay.');
  } finally { stand.generator.releaseHeld(); await h.stop(); }
});

it('excludes bank evidence from offer memory and starts a fresh memory when the contact reopens', async () => {
  const stand = standIns();
  const generator: ReplyGenerator = stand.generator;
  const calls = vi.spyOn(generator, 'generate');
  const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
  try {
    const offer = 'I am selling a bamboo chair.';
    await h.receive(CHATS.a, offer);
    await h.app.drain();
    expect(calls.mock.calls.at(-1)?.[4]?.offer).toBe(offer);
    await h.receive(CHATS.a, 'I am selling a blue lamp. For the bank transfer, my bank account number is 0000000000123456.');
    await h.app.drain();
    const chat = (await h.chatFor(CHATS.a))!;
    const review = chat.telegramReplyHold.officerReview;
    expect(review.reason).toBe('bank_details');
    const result = await h.call('POST', `/v1/chats/${chat.id}/officer-decisions`, {
      decision: 'mark_reviewed', reviewActionId: review.actionId, expectedRevision: chat.revision,
    });
    expect(result.success).toBe(true);
    await h.receive(CHATS.a, 'What were we talking about?');
    await h.app.drain();
    expect(calls.mock.calls.at(-1)?.[4]).toEqual({ offer });
    await h.receive(CHATS.a, 'Stop');
    await h.receive(CHATS.a, 'Hello again');
    await h.app.drain();
    expect(calls.mock.calls.at(-1)?.[4]).toBeUndefined();
  } finally { await h.stop(); }
});

it('rewrites a follow-up about completed terms and allows a useful question on the next offer', async () => {
  const stand = standIns();
  const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
  try {
    stand.generator.replyNext('How much is everything?', 'Got it, thanks.');
    await h.receive(CHATS.a, 'I am selling two ceramic bowls, 30 in total. That’s the whole offer.');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
    expect(stand.sender.sent[0]?.reply.text).toBe('Got it, thanks.');
    expect(stand.generator.corrections).toEqual([undefined, correctionFor('unneeded_offer_question')]);

    stand.generator.replyNext('How big is the desk?');
    await h.receive(CHATS.a, 'I am selling a folding desk.');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(2), WAIT);
    expect(stand.sender.sent[1]?.reply.text).toBe('How big is the desk?');
  } finally {
    await h.stop();
  }
});

it('rewrites a premature job-fee refusal, then lets the sender lead after their explanation', async () => {
  const stand = standIns();
  const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
  try {
    stand.generator.replyNext('What are the hours?', "I'll pass.", "what's the fee for", 'oh okay');
    await h.receive(CHATS.a, 'I have a job opportunity if you like.');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
    await h.receive(CHATS.a, 'Three hours packing boxes. You need to pay a starter fee first.');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(2), WAIT);
    expect(stand.sender.sent[1]?.reply.text).toBe("what's the fee for");
    expect(stand.generator.corrections.at(-1)).toBe(correctionFor('fee_purpose_question'));
    await h.receive(CHATS.a, 'It covers your staff badge.');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(3), WAIT);
    expect(stand.sender.sent[2]?.reply.text).toBe('oh okay');
  } finally {
    await h.stop();
  }
});

describe('reply quiet period', () => {
  it('submits to the synthetic sender at least three wall-clock seconds after local receipt', async () => {
    const stand = standIns();
    stand.generator.replyNext('Hey');
    vi.spyOn(stand.clock, 'now').mockImplementation(systemClock.now);
    vi.spyOn(stand.clock, 'after').mockImplementation(systemClock.after);
    let submittedAt = 0;
    const send = stand.sender.sendBusinessMessage.bind(stand.sender);
    vi.spyOn(stand.sender, 'sendBusinessMessage').mockImplementation((reply) => {
      submittedAt = Date.now();
      return send(reply);
    });
    const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
    try {
      await h.deliver(incoming(CHATS.a, 'Hi', Date.now()));
      const [message] = (await h.timelineOf(CHATS.a)).messages;
      await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
      expect(stand.sender.sent[0]?.reply.text).toBe('Hey');
      expect(stand.generator.histories).toEqual([[{ from: 'contact', text: 'Hi' }]]);
      expect(submittedAt - Date.parse(message.receivedAt)).toBeGreaterThanOrEqual(3_000);
    } finally {
      await h.stop();
    }
  });

  it('cancels a pending timer when a stop request arrives in the same burst and remains silent after restart', async () => {
    const env = { ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' };
    const first = standIns();
    let h = await Harness.start(env, first);
    try {
      await h.deliver(incoming(CHATS.a, 'Hello', first.clock.now().getTime()));
      first.clock.advance(2_999);
      await h.deliver(incoming(CHATS.a, 'Please don’t message me again!', first.clock.now().getTime()));
      first.clock.advance(5_000);
      await h.app.drain();
      expect(first.generator.histories).toHaveLength(0);
      expect(first.sender.sent).toHaveLength(0);
      expect(await h.caseActionsOf(CHATS.a, 'telegram_contact_opted_out')).toHaveLength(1);
      expect(await h.caseActionsOf(CHATS.a, 'telegram_officer_review_requested')).toHaveLength(0);
      await h.close();
      const after = standIns(first.clock);
      h = await Harness.start(env, after, h.data);
      await h.receive(CHATS.a, 'Hello again');
      await h.app.drain();
      expect(after.generator.histories).toHaveLength(0);
      expect(after.sender.sent).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });

  it.each(['document', 'location', 'bank_details', 'stop'] as const)('rechecks a pending reply when the contact supplies new material or opts out (%s)', async (kind) => {
    const stand = standIns();
    const generate = vi.spyOn(stand.generator, 'generate');
    const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
    try {
      if (kind === 'document' || kind === 'location') {
        const first = incoming(CHATS.a, kind === 'document' ? 'The pickup is at 12 Example Road.' : '', stand.clock.now().getTime());
        if (kind === 'location') Object.assign(first.business_message as Json, { document: { file_id: 'first-synthetic-file' } });
        await h.deliver(first);
        const hold = (await h.chatFor(CHATS.a))?.telegramReplyHold;
        expect(hold.officerReview).toBeNull();
        expect(hold.evidenceItems).toHaveLength(1);
      }
      stand.generator.holdNext();
      await h.receive(CHATS.a, 'Is that delivery fee expected?');
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1), WAIT);
      const inputs = {
        location: 'The transfer office is at 12 Example Road.', document: '', stop: 'Stop',
        bank_details: 'For the bank transfer, my bank account number is 0000000000123456.',
      };
      const text = inputs[kind];
      const update = incoming(CHATS.a, text, stand.clock.now().getTime());
      if (kind === 'document') Object.assign(update.business_message as Json, { document: { file_id: 'test-file', file_unique_id: 'test-id' } });
      await h.deliver(update);
      expect(generate.mock.calls[0]?.[1]?.aborted).toBe(true);
      stand.generator.releaseHeld();
      stand.clock.advance(3_000);
      await h.app.drain();
      expect(stand.sender.sent).toHaveLength(kind === 'location' ? 1 : 0);
      expect(await h.caseActionsOf(CHATS.a, 'ai_reply_failed')).toHaveLength(0);
      if (kind !== 'stop') {
        const hold = (await h.chatFor(CHATS.a))?.telegramReplyHold;
        if (kind === 'bank_details') expect(hold.officerReview?.reason).toBe('bank_details');
        else expect(hold.officerReview).toBeNull();
        expect(hold.evidenceItems.map((item: Json) => item.reason).sort())
          .toEqual(kind === 'bank_details' ? ['bank_details'] : ['document', 'location']);
        if (kind === 'bank_details') expect(h.logs.join('\n')).not.toContain('0000000000123456');
      }
    } finally {
      stand.generator.releaseHeld();
      await h.stop();
    }
  });

  it('lets a quiet chat go first while another contact is still typing', async () => {
    const stand = standIns();
    const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
    try {
      const send = (chat: number, text: string) => h.deliver(incoming(chat, text, stand.clock.now().getTime()));
      await send(CHATS.a, 'A first');
      stand.clock.advance(1_000);
      await send(CHATS.b, 'B only');
      stand.clock.advance(1_900);
      await send(CHATS.a, 'A second');
      await h.app.drain();
      expect(stand.sender.sent).toHaveLength(0);
      stand.clock.advance(1_100);
      await vi.waitFor(() => expect(stand.sender.sent.map((s) => s.reply.chatId)).toEqual([CHATS.b]), WAIT);
      stand.clock.advance(1_900);
      await vi.waitFor(() => expect(stand.sender.sent.map((s) => s.reply.chatId)).toEqual([CHATS.b, CHATS.a]), WAIT);
    } finally {
      await h.stop();
    }
  });

  it('coalesces bursts, makes no model call before three seconds and wakes at the deadline without polling', async () => {
    const stand = standIns();
    const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
    const post = (text: string) => h.deliver(incoming(CHATS.a, text, stand.clock.now().getTime()));
    try {
      await post('First part');
      await h.app.drain();
      expect(stand.generator.histories).toHaveLength(0);
      stand.clock.advance(2_900);
      await post('Here is the next part');
      await h.app.drain();
      stand.clock.advance(2_999);
      await h.app.drain();
      expect(stand.sender.sent).toHaveLength(0);
      expect(stand.generator.histories).toHaveLength(0);
      stand.clock.advance(1);
      await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
      expect(stand.generator.histories).toEqual([[
        { from: 'contact', text: 'First part' }, { from: 'contact', text: 'Here is the next part' },
      ]]);
    } finally {
      await h.stop();
    }
  });

  it('preserves the remaining quiet time across restart and resets it when an incoming message is edited', async () => {
    const first = standIns();
    const env = { ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' };
    let h = await Harness.start(env, first);
    try {
      const message = incoming(CHATS.a, 'Original question', first.clock.now().getTime());
      await h.deliver(message);
      await h.app.drain();
      expect(first.sender.sent).toHaveLength(0);
      first.clock.advance(1_500);
      await h.close();
      const second = standIns(first.clock);
      h = await Harness.start(env, second, h.data);
      await h.app.drain();
      first.clock.advance(1_499);
      await h.app.drain();
      expect(second.sender.sent).toHaveLength(0);
      const edited = incoming(CHATS.a, 'Edited question', first.clock.now().getTime());
      await h.deliver({
        update_id: edited.update_id,
        edited_business_message: { ...(edited.business_message as Json), message_id: (message.business_message as Json).message_id },
      });
      await h.app.drain();
      first.clock.advance(2_999);
      await h.app.drain();
      expect(second.sender.sent).toHaveLength(0);
      first.clock.advance(1);
      await vi.waitFor(() => expect(second.sender.sent).toHaveLength(1), WAIT);
      expect(second.generator.histories).toEqual([[{ from: 'contact', text: 'Edited question' }]]);
    } finally {
      await h.stop();
    }
  });
});

describe('local-model replies in an approved Telegram chat', () => {
  const stand = standIns();
  const { sender, generator, clock } = stand;
  let h: Harness;

  beforeAll(async () => {
    h = await Harness.start(LIVE_ENV, stand);
  });

  afterAll(async () => {
    await h.stop();
  });

  it('waits until the chat is AI active, answers the latest message, and stores the reply as Telegram would', async () => {
    const question = await h.receive(CHATS.a, 'Hello, is the flat still available this week?');
    await h.app.drain();
    expect(sender.to(CHATS.a)).toHaveLength(0);

    await h.dispatch(CHATS.a);
    await vi.waitFor(() => expect(sender.to(CHATS.a)).toHaveLength(1), WAIT);
    const [sent] = sender.to(CHATS.a);
    expect(sent?.reply).toEqual({ businessConnectionId: CONNECTION_ID, chatId: CHATS.a, text: 'Thanks for your message (1).' });
    expect(generator.histories.at(-1)).toEqual([{ from: 'contact', text: 'Hello, is the flat still available this week?' }]);

    await vi.waitFor(async () => expect((await h.caseActionsOf(CHATS.a, 'ai_reply_sent')).length).toBe(1), WAIT);
    const timeline = await h.timelineOf(CHATS.a);
    const reply = (timeline.messages as Json[]).at(-1) as Json;
    expect(reply).toMatchObject({ direction: 'outgoing', origin: 'source', text: sent?.message.text, source: { captureMethod: 'telegram_business_live' } });
    const [action] = await h.caseActionsOf(CHATS.a, 'ai_reply_sent');
    expect(action).toMatchObject({ messageId: reply.id, actor: null, detail: { source: 'model', inReplyTo: question.id, model: 'test-model', telegramMessageId: sent?.message.message_id } });

    // Telegram's own copy of the reply adds nothing, and the reply is not answered.
    if (!sent) throw new Error('no reply sent');
    h.stand.api.queue(echoOf(sent.message));
    await vi.waitFor(() => expect(h.logged('telegram_live_batch', '"duplicates":1')).toBe(true), WAIT);
    await h.app.drain();
    expect((await h.timelineOf(CHATS.a)).messages).toHaveLength(2);
    expect(sender.to(CHATS.a)).toHaveLength(1);
    // Neither the contact's text nor the model's reply reaches a log.
    const logText = h.logs.join('\n');
    expect(logText).not.toContain('flat still available');
    expect(logText).not.toContain('Thanks for your message');
  });

  it('stays quiet while an officer controls the chat and answers again after Resume AI', async () => {
    await h.receive(CHATS.b, 'Hi, can I see the flat on Friday?');
    await h.dispatch(CHATS.b);
    await vi.waitFor(() => expect(sender.to(CHATS.b)).toHaveLength(1), WAIT);

    await h.control(CHATS.b, 'take_over');
    await h.receive(CHATS.b, 'For two people, please.');
    await h.app.drain();
    expect(sender.to(CHATS.b)).toHaveLength(1);

    await h.control(CHATS.b, 'resume');
    await vi.waitFor(() => expect(sender.to(CHATS.b)).toHaveLength(2), WAIT);
    expect(generator.histories.at(-1)?.at(-1)).toEqual({ from: 'contact', text: 'For two people, please.' });
  });

  it('keeps a failure in the case log, never retries that message, and answers the next one', async () => {
    generator.failNext('lmstudio_timeout');
    const first = await h.receive(CHATS.c, 'Is anyone there?');
    await h.dispatch(CHATS.c);
    await vi.waitFor(async () => expect((await h.caseActionsOf(CHATS.c, 'ai_reply_failed')).length).toBe(1), WAIT);
    const [failed] = await h.caseActionsOf(CHATS.c, 'ai_reply_failed');
    expect(failed).toMatchObject({ messageId: first.id, actor: null, detail: { code: 'lmstudio_timeout', status: null } });
    await h.app.drain();
    expect(sender.to(CHATS.c)).toHaveLength(0);

    await h.receive(CHATS.c, 'Hello?');
    await vi.waitFor(() => expect(sender.to(CHATS.c)).toHaveLength(1), WAIT);

    sender.refuse(403);
    const third = await h.receive(CHATS.c, 'Thanks!');
    await vi.waitFor(async () => expect((await h.caseActionsOf(CHATS.c, 'ai_reply_failed')).length).toBe(2), WAIT);
    const refused = (await h.caseActionsOf(CHATS.c, 'ai_reply_failed')).at(-1);
    expect(refused).toMatchObject({ messageId: third.id, detail: { code: 'telegram_api_error', status: 403 } });
    expect(h.logs.join('\n')).not.toContain('Thanks!');
  });

  it('drops a reply when a newer message arrives while the model writes, then answers the newer one', async () => {
    await h.receive(CHATS.d, 'First question');
    const calls = generator.histories.length;
    generator.holdNext();
    await h.dispatch(CHATS.d);
    await vi.waitFor(() => expect(generator.histories.length).toBe(calls + 1), WAIT);
    const newer = await h.receive(CHATS.d, 'Second question, sent before any reply');
    generator.releaseHeld();

    await vi.waitFor(() => expect(sender.to(CHATS.d)).toHaveLength(1), WAIT);
    expect(h.logged('telegram_ai_reply_discarded', '"reason":"newer_message"')).toBe(true);
    const [action] = await h.caseActionsOf(CHATS.d, 'ai_reply_sent');
    expect(action?.detail.inReplyTo).toBe(newer.id);
    expect(generator.histories.at(-1)?.map((t) => t.text)).toEqual(['First question', 'Second question, sent before any reply']);
  });

  it('drops a reply when an officer takes over while the model writes, and answers that message after Resume AI', async () => {
    const question = await h.receive(CHATS.e, 'Can I pay the deposit later?');
    const calls = generator.histories.length;
    generator.holdNext();
    await h.dispatch(CHATS.e);
    await vi.waitFor(() => expect(generator.histories.length).toBe(calls + 1), WAIT);
    await h.control(CHATS.e, 'take_over');
    generator.releaseHeld();

    await vi.waitFor(() => expect(h.logged('telegram_ai_reply_discarded', '"reason":"mode_changed"')).toBe(true), WAIT);
    await h.app.drain();
    expect(sender.to(CHATS.e)).toHaveLength(0);

    await h.control(CHATS.e, 'resume');
    await vi.waitFor(() => expect(sender.to(CHATS.e)).toHaveLength(1), WAIT);
    const [action] = await h.caseActionsOf(CHATS.e, 'ai_reply_sent');
    expect(action?.detail.inReplyTo).toBe(question.id);
  });

  it('drops a reply when the contact deletes the message while the model writes', async () => {
    const question = await h.receive(CHATS.i, 'Wrong chat, sorry');
    const calls = generator.histories.length;
    generator.holdNext();
    await h.dispatch(CHATS.i);
    await vi.waitFor(() => expect(generator.histories.length).toBe(calls + 1), WAIT);
    await h.deleteAtSource(CHATS.i, question);
    generator.releaseHeld();

    await vi.waitFor(() => expect(h.logged('telegram_ai_reply_discarded', '"reason":"not_answerable"')).toBe(true), WAIT);
    await h.app.drain();
    expect(sender.to(CHATS.i)).toHaveLength(0);
    expect(await h.caseActionsOf(CHATS.i, 'ai_reply_failed')).toHaveLength(0);
  });

  it('discards a draft when the contact edits its source text before submission', async () => {
    const message = await h.receive(CHATS.k, 'Original text for the test');
    const calls = generator.histories.length;
    const draft = 'Draft using the original text.';
    generator.replyNext(draft);
    generator.holdNext();
    try {
      await h.dispatch(CHATS.k);
      await vi.waitFor(() => expect(generator.histories.length).toBe(calls + 1), WAIT);
      const edit = incoming(CHATS.k, 'Replacement text', clock.now().getTime());
      await h.deliver({
        update_id: edit.update_id,
        edited_business_message: { ...(edit.business_message as Json), message_id: message.telegramMessageId },
      });
    } finally {
      generator.releaseHeld();
    }
    await h.app.drain();

    expect(sender.to(CHATS.k).map((s) => s.reply.text)).not.toContain(draft);
    expect(await h.caseActionsOf(CHATS.k, 'ai_reply_failed')).toHaveLength(0);
  });

  it('keeps a deleted earlier turn out of further model requests while a draft is pending', async () => {
    const withdrawn = 'Earlier message withdrawn during the test';
    const earlier = await h.receive(CHATS.l, withdrawn);
    await h.receive(CHATS.l, 'Follow-up test message');
    const calls = generator.histories.length;
    generator.replyNext('https://example.test');
    generator.holdNext();
    try {
      await h.dispatch(CHATS.l);
      await vi.waitFor(() => expect(generator.histories.length).toBe(calls + 1), WAIT);
      expect(generator.histories[calls]).toContainEqual({ from: 'contact', text: withdrawn });
      await h.deleteAtSource(CHATS.l, earlier);
    } finally {
      generator.releaseHeld();
    }
    await h.app.drain();

    const laterTurns = generator.histories.slice(calls + 1).flat();
    expect(laterTurns).not.toContainEqual({ from: 'contact', text: withdrawn });
    expect(await h.caseActionsOf(CHATS.l, 'ai_reply_failed')).toHaveLength(0);
  });

  it('starts no model request for a caption cleared before Dispatch', async () => {
    await h.receive(CHATS.m, 'Earlier message');
    const source = incoming(CHATS.m, 'Caption withdrawn before dispatch', clock.now().getTime());
    const { text, ...message } = source.business_message as Json;
    const photo = { ...message, photo: [{ file_id: 'test-file', file_unique_id: 'test-unique', width: 10, height: 10 }] };
    await h.deliver({ update_id: source.update_id, business_message: { ...photo, caption: text } });
    const edit = incoming(CHATS.m, '', clock.now().getTime());
    await h.deliver({
      update_id: edit.update_id,
      edited_business_message: { ...photo, edit_date: message.date },
    });
    expect((await h.timelineOf(CHATS.m)).messages.at(-1)).toMatchObject({ text, editedAtSource: true });
    const calls = generator.histories.length;
    await h.dispatch(CHATS.m);
    await h.app.drain();

    expect(generator.histories).toHaveLength(calls);
    expect(sender.to(CHATS.m)).toHaveLength(0);
  });

  it('records no failure when the model fails after an officer took over, so Resume AI still answers the message', async () => {
    const question = await h.receive(CHATS.j, 'Is the price negotiable?');
    const calls = generator.histories.length;
    generator.failNext('lmstudio_unreachable');
    generator.holdNext();
    await h.dispatch(CHATS.j);
    await vi.waitFor(() => expect(generator.histories.length).toBe(calls + 1), WAIT);
    await h.control(CHATS.j, 'take_over');
    generator.releaseHeld();

    const chat = await h.chatFor(CHATS.j);
    await vi.waitFor(() => expect(h.logged('telegram_ai_reply_discarded', '"reason":"mode_changed"', `"chatId":"${chat?.id}"`)).toBe(true), WAIT);
    await h.app.drain();
    expect(await h.caseActionsOf(CHATS.j, 'ai_reply_failed')).toHaveLength(0);

    await h.control(CHATS.j, 'resume');
    await vi.waitFor(() => expect(sender.to(CHATS.j)).toHaveLength(1), WAIT);
    const [action] = await h.caseActionsOf(CHATS.j, 'ai_reply_sent');
    expect(action?.detail.inReplyTo).toBe(question.id);
  });

  it('does not answer a message older than the freshness window', async () => {
    await h.receive(CHATS.f, 'An old question');
    clock.advance(REPLY_FRESHNESS_MS + 60_000);
    await h.dispatch(CHATS.f);
    await h.app.drain();
    expect(sender.to(CHATS.f)).toHaveLength(0);

    await h.receive(CHATS.f, 'A new question');
    await vi.waitFor(() => expect(sender.to(CHATS.f)).toHaveLength(1), WAIT);
  });

  it('does not answer a backlog Telegram delivers late: a message sent before the window, received just now', async () => {
    await h.receive(CHATS.g, 'Sent while Mirsad was down', clock.now().getTime() - REPLY_FRESHNESS_MS - 60_000);
    await h.dispatch(CHATS.g);
    await h.app.drain();
    expect(sender.to(CHATS.g)).toHaveLength(0);

    await h.receive(CHATS.g, 'Sent just now');
    await vi.waitFor(() => expect(sender.to(CHATS.g)).toHaveLength(1), WAIT);
  });

  it('writes a blocked reply once more, and keeps a failure with the rule when every draft is blocked', async () => {
    const attempts = generator.corrections.length;
    generator.replyNext('Open https://blocked.example.test');
    await h.receive(CHATS.h, 'Will you pay today?');
    await h.dispatch(CHATS.h);
    await vi.waitFor(() => expect(sender.to(CHATS.h)).toHaveLength(1), WAIT);
    expect(sender.to(CHATS.h)[0]?.reply.text).toMatch(/^Thanks for your message \(\d+\)\.$/);
    expect(h.logged('telegram_ai_reply_blocked', '"attempt":1', '"rule":"link"')).toBe(true);
    expect(generator.corrections.slice(attempts)).toEqual([undefined, correctionFor('link')]);

    generator.replyNext('Call me on 050 123 4567.', 'My number is 050 123 4567.');
    const second = await h.receive(CHATS.h, 'How do I reach you?');
    await vi.waitFor(async () => expect((await h.caseActionsOf(CHATS.h, 'ai_reply_failed')).length).toBe(1), WAIT);
    const [failed] = await h.caseActionsOf(CHATS.h, 'ai_reply_failed');
    expect(failed).toMatchObject({ messageId: second.id, detail: { code: 'blocked_reply', status: null, rule: 'long_number' } });
    expect(sender.to(CHATS.h)).toHaveLength(1);
    const logText = h.logs.join('\n');
    expect(logText).not.toContain('123 4567');
    expect(logText).not.toContain('blocked.example.test');
  });
});

describe('local-model replies across a restart', () => {
  it('uses model wording and deliberate silence on repeated identity checks, then answers a mixed burst after restart', async () => {
    const stand = standIns();
    const env = { ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' };
    let h = await Harness.start(env, stand);
    try {
      const question = 'Are you AI?';
      const answers = ['What do you mean?', 'This chat uses AI.'];
      stand.generator.replyNext(...answers, 'Yes, these replies are automated.', null);
      for (let i = 0; i < 4; i++) {
        await h.deliver(incoming(CHATS.a, question, stand.clock.now().getTime()));
        stand.clock.advance(3_000);
        await h.app.drain();
      }
      expect(stand.sender.sent.map(sent => sent.reply.text)).toEqual(answers);
      expect(stand.generator.histories).toHaveLength(4);
      expect(stand.generator.histories[1]).toContainEqual({ from: 'owner', text: answers[0] });
      expect(stand.generator.histories[2]?.filter(turn => turn.from === 'owner').map(turn => turn.text)).toEqual(answers);
      const actions = await h.caseActionsOf(CHATS.a, 'ai_reply_sent');
      expect(actions.map(action => [action.detail.source, action.detail.model])).toEqual([
        ['model', 'test-model'], ['model', 'test-model'],
      ]);
      const skips = await h.caseActionsOf(CHATS.a, 'ai_reply_skipped');
      expect(skips.map(action => action.detail)).toEqual([
        { source: 'reply_guard', reason: 'repeated_identity_question' },
        { source: 'model', reason: 'reason_unavailable', model: stand.generator.model },
      ]);
      await h.close();
      const after = standIns(stand.clock);
      h = await Harness.start(env, after, h.data);
      await h.app.drain();
      expect(after.sender.sent).toHaveLength(0);
      expect(after.generator.histories).toHaveLength(0);
      const post = (text: string) => h.deliver(incoming(CHATS.a, text, after.clock.now().getTime()));
      const fee = 'Is the delivery fee legitimate?';
      after.generator.replyNext('I can’t verify that fee.');
      await post(fee);
      after.clock.advance(3_000);
      await h.app.drain();
      expect(after.generator.currentTurns).toEqual([[fee]]);
      expect(after.sender.sent.map(sent => sent.reply.text)).toEqual(['I can’t verify that fee.']);
      await post('Which day did I mention?');
      after.clock.advance(1_000);
      await post('Are you a bot?');
      after.generator.replyNext('It’s automated. You mentioned Thursday.');
      after.clock.advance(3_000);
      await vi.waitFor(() => expect(after.sender.sent).toHaveLength(2), WAIT);
      expect(after.sender.sent[1]?.reply.text).toBe('It’s automated. You mentioned Thursday.');
      expect(after.generator.currentTurns[1]).toEqual(['Which day did I mention?', 'Are you a bot?']);
      expect(after.generator.histories).toHaveLength(2);
      expect(after.generator.histories[1]?.slice(-2)).toEqual([
        { from: 'contact', text: 'Which day did I mention?' }, { from: 'contact', text: 'Are you a bot?' },
      ]);
      after.generator.replyNext('Yes, replies here are automated.');
      await post(question);
      after.clock.advance(3_000);
      await h.app.drain();
      expect(after.sender.sent.at(-1)?.reply.text).toBe('Yes, replies here are automated.');
    } finally {
      await h.stop();
    }
  });

  it('answers an Arabic clarification and first direct question, and suppresses a reworded draft on an identical repeat', async () => {
    const stand = standIns();
    const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
    try {
      stand.generator.replyNext('تقصد مين يرد؟', 'نعم، أنا بوت.', 'نعم، بوت.');
      for (const text of ['بوت؟', 'هل أنت روبوت؟', 'هل أنت روبوت؟']) {
        await h.deliver(incoming(CHATS.a, text, stand.clock.now().getTime()));
        stand.clock.advance(3_000);
        await h.app.drain();
      }
      expect(stand.generator.histories).toHaveLength(3);
      expect(stand.sender.sent.map(sent => sent.reply.text)).toEqual(['تقصد مين يرد؟', 'نعم، أنا بوت.']);
      expect(await h.caseActionsOf(CHATS.a, 'ai_reply_skipped')).toHaveLength(1);
    } finally {
      await h.stop();
    }
  });

  it('retries an unverified pickup confirmation with the current incoming question as context', async () => {
    const stand = standIns();
    const h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
    try {
      stand.generator.replyNext('Yes, the pickup was confirmed for 24 Sample Road.', 'I cannot verify that location.');
      await h.receive(CHATS.a, 'Do you know whether the pickup was at 24 Sample Road?');
      await vi.waitFor(() => expect(stand.sender.to(CHATS.a)).toHaveLength(1), WAIT);
      expect(stand.sender.to(CHATS.a)[0]?.reply.text).toBe('I cannot verify that location.');
      expect(stand.generator.corrections).toEqual([undefined, expect.stringContaining('location')]);
    } finally {
      await h.stop();
    }
  });

  it('starts on a fresh turn, greets without a preamble, and skips old work after restart', async () => {
    const before = standIns();
    let h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_REPLIES_ENABLED: 'false' }, before);
    try {
      await h.receive(CHATS.a, 'Message received before replies were enabled');
      await h.dispatch(CHATS.a);
      await h.close();
      const after = standIns(before.clock);
      h = await Harness.start(LIVE_ENV, after, h.data);
      await h.app.drain();
      expect(after.generator.histories).toHaveLength(0);
      after.generator.replyNext('Hi there');
      await h.receive(CHATS.a, 'Hi');
      await vi.waitFor(() => expect(after.sender.to(CHATS.a)).toHaveLength(1), WAIT);
      expect(after.sender.to(CHATS.a)[0]?.reply.text).toBe('Hi there');
      expect(after.generator.histories).toEqual([[{ from: 'contact', text: 'Hi' }]]);
      const [first] = await h.caseActionsOf(CHATS.a, 'ai_reply_sent');
      expect(first?.detail).toMatchObject({ source: 'model', model: 'test-model' });
      expect(first?.detail.assistantDisclosed).toBeUndefined();
      await h.close();
      const next = standIns(before.clock);
      h = await Harness.start(LIVE_ENV, next, h.data);
      await h.app.drain();
      expect(next.sender.sent).toHaveLength(0);
      expect(next.generator.histories).toHaveLength(0);
      next.generator.replyNext('Hey');
      await h.deliver(incoming(CHATS.a, 'Hi', next.clock.now().getTime()));
      next.clock.advance(3_000);
      await vi.waitFor(() => expect(next.sender.to(CHATS.a)).toHaveLength(1), WAIT);
      expect(next.sender.to(CHATS.a)[0]?.reply.text).toBe('Hey');
      expect(next.generator.histories).toHaveLength(1);
    } finally {
      await h.stop();
    }
  });

  it('keeps a deliberately silent turn silent after a restart', async () => {
    const stand = standIns();
    const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>()
      .mockResolvedValue({ kind: 'silence', reason: 'conversation_closed' });
    Object.assign(stand.generator, { decide });
    let h = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_AUTO_START: 'true' }, stand);
    try {
      const incomingText = 'Thanks for clearing up the sample order.';
      const message = await h.receive(CHATS.a, incomingText);
      await vi.waitFor(async () => expect(await h.caseActionsOf(CHATS.a, 'ai_reply_skipped')).toHaveLength(1), WAIT);
      const detail = { source: 'model', reason: 'conversation_closed', model: stand.generator.model };
      expect((await h.caseActionsOf(CHATS.a, 'ai_reply_skipped'))[0]).toMatchObject({ messageId: message.id, detail });
      expect(h.logged('telegram_ai_reply_skipped', `"messageId":"${message.id}"`, '"source":"model"', '"reason":"conversation_closed"')).toBe(true);
      expect(h.logs.join('\n')).not.toContain(incomingText);
      expect(decide).toHaveBeenCalledTimes(1);
      expect(stand.sender.sent).toHaveLength(0);
      await h.close();
      const after = standIns(stand.clock);
      h = await Harness.start(LIVE_ENV, after, h.data);
      await h.app.drain();
      expect((await h.caseActionsOf(CHATS.a, 'ai_reply_skipped')).map(action => action.detail)).toEqual([detail]);
      expect(after.generator.histories).toHaveLength(0);
      expect(after.sender.sent).toHaveLength(0);
      expect(await h.caseActionsOf(CHATS.a, 'ai_reply_failed')).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });

  it('keeps a recorded failure: the failed message is not tried again after a restart, the next one is answered', async () => {
    const first = standIns();
    const before = await Harness.start(LIVE_ENV, first);
    let current: Harness = before;
    try {
      first.generator.failNext('lmstudio_unreachable');
      await before.receive(CHATS.a, 'Are you there?');
      await before.dispatch(CHATS.a);
      await vi.waitFor(async () => expect((await before.caseActionsOf(CHATS.a, 'ai_reply_failed')).length).toBe(1), WAIT);
      await before.close();

      const second = standIns(first.clock);
      current = await Harness.start(LIVE_ENV, second, before.data);
      await current.app.drain();
      expect(second.generator.histories).toHaveLength(0);
      expect(second.sender.sent).toHaveLength(0);

      await current.receive(CHATS.a, 'Hello again');
      await vi.waitFor(() => expect(second.sender.to(CHATS.a)).toHaveLength(1), WAIT);
    } finally {
      await current.stop();
    }
  });

  it('requires a new message after restoring a previously approved chat', async () => {
    const first = standIns();
    const before = await Harness.start(LIVE_ENV, first);
    let current: Harness = before;
    try {
      await before.receive(CHATS.b, 'Is the studio free?');
      await before.dispatch(CHATS.b);
      await vi.waitFor(() => expect(first.sender.to(CHATS.b)).toHaveLength(1), WAIT);
      await before.control(CHATS.b, 'take_over');
      await before.receive(CHATS.b, 'Waiting for an answer');
      await before.close();

      const others = Object.values(CHATS).filter((id) => id !== CHATS.b).join(',');
      const unapproved = standIns(first.clock);
      current = await Harness.start({ ...LIVE_ENV, TELEGRAM_APPROVED_CHAT_IDS: others }, unapproved, before.data);
      await current.control(CHATS.b, 'resume');
      await current.app.drain();
      expect(unapproved.generator.histories).toHaveLength(0);
      expect(unapproved.sender.to(CHATS.b)).toHaveLength(0);
      await current.close();

      const approved = standIns(first.clock);
      current = await Harness.start(LIVE_ENV, approved, before.data);
      await current.app.drain();
      expect(approved.generator.histories).toHaveLength(0);
      await current.receive(CHATS.b, 'New message after approval was restored');
      await vi.waitFor(() => expect(approved.sender.to(CHATS.b)).toHaveLength(1), WAIT);
      expect(approved.generator.histories[0]).toEqual([{ from: 'contact', text: 'New message after approval was restored' }]);
    } finally {
      await current.stop();
    }
  });
});

describe('local-model reply gates', () => {
  async function disableConnection(h: Harness): Promise<void> {
    const connection = await h.stand.api.getBusinessConnection();
    await h.deliver({ update_id: 1_800_000_000, business_connection: { ...connection, is_enabled: false } });
    expect(h.logged('telegram_live_connector_stopped', '"reason":"connection_disabled"')).toBe(true);
  }

  it('aborts the model request and blocks queued work when the connection is disabled', async () => {
    const stand = standIns();
    const h = await Harness.start(LIVE_ENV, stand);
    const generate = vi.spyOn(stand.generator, 'generate');
    try {
      await h.receive(CHATS.a, 'First message');
      await h.receive(CHATS.b, 'Waiting message');
      stand.generator.holdNext();
      await h.dispatch(CHATS.a);
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1), WAIT);
      await disableConnection(h);
      await h.dispatch(CHATS.b);
      expect(generate.mock.calls[0]?.[1]?.aborted).toBe(true);
      stand.generator.releaseHeld();
      await h.app.drain();
      expect(generate).toHaveBeenCalledTimes(1);
      expect(stand.sender.sent).toHaveLength(0);
      expect(await h.caseActionsOf(CHATS.a, 'ai_reply_failed')).toHaveLength(0);
    } finally {
      stand.generator.releaseHeld();
      await h.stop();
    }
  });

  it('records the outcome of a request submitted before the connection was disabled', async () => {
    const stand = standIns();
    const h = await Harness.start(LIVE_ENV, stand);
    const sender: BotSender = stand.sender;
    const record = sender.sendBusinessMessage.bind(sender);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.spyOn(sender, 'sendBusinessMessage').mockImplementationOnce(async (reply, signal) => {
      await held;
      signal?.throwIfAborted();
      return record(reply, signal);
    });
    try {
      const message = await h.receive(CHATS.a, 'Test before connection stops');
      await h.dispatch(CHATS.a);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1), WAIT);
      await disableConnection(h);
      release();
      await h.app.drain();
      const [sent] = await h.caseActionsOf(CHATS.a, 'ai_reply_sent');
      expect(sent?.detail.inReplyTo).toBe(message.id);
      expect(await h.caseActionsOf(CHATS.a, 'ai_reply_failed')).toHaveLength(0);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await h.stop();
    }
  });

  it('refuses to start without a consent reference and names the missing setting', async () => {
    const refused = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_REPLY_CONSENT_REFERENCE: '' }, standIns());
    try {
      expect(refused.logged('telegram_ai_replies_refused', 'TELEGRAM_AI_REPLY_CONSENT_REFERENCE')).toBe(true);
      expect(refused.logged('telegram_ai_replies_started')).toBe(false);
    } finally {
      await refused.stop();
    }
  });

  it('refuses to start when a live connector gate is missing, and names it', async () => {
    const refused = await Harness.start({ ...LIVE_ENV, TELEGRAM_APPROVAL_REFERENCE: '' }, standIns());
    try {
      expect(refused.logged('telegram_ai_replies_refused', 'TELEGRAM_APPROVAL_REFERENCE')).toBe(true);
      expect(refused.logged('telegram_ai_replies_started')).toBe(false);
    } finally {
      await refused.stop();
    }
  });

  it('creates no reply worker at all while the switch is off', async () => {
    const off = await Harness.start({ ...LIVE_ENV, TELEGRAM_AI_REPLIES_ENABLED: 'false' }, standIns());
    try {
      expect(off.logs.some((l) => l.includes('telegram_ai_replies'))).toBe(false);
      expect(off.logged('telegram_live_connector_started')).toBe(true);
    } finally {
      await off.stop();
    }
  });
});
