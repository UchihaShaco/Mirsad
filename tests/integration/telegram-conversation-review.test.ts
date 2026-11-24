import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AliDecision } from '../../src/replies/ali-decision.ts';
import { ReplyGenerationError, type ReplyGenerator } from '../../src/replies/reply-generator.ts';
import { Harness, incoming, LIVE_BASE_ENV, standIns } from '../helpers/telegram-live-harness.ts';

const contact = 6000000889;
const env = { ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true' };
const review: AliDecision = { kind: 'review', status: 'READY_FOR_OFFICER_REVIEW', reasons: ['upfront_fee', 'payment_pressure'] };

it('delivers a safe reply alongside a conversation warning and keeps answering after restart', async () => {
  let stand = standIns();
  const decide = vi.fn<() => Promise<AliDecision>>()
    .mockResolvedValueOnce({ kind: 'reply', text: 'What does the fee cover?' })
    .mockResolvedValueOnce(review)
    .mockResolvedValueOnce({ kind: 'reply', text: 'Yes, I am here.' })
    .mockResolvedValue({ kind: 'reply', text: 'Understood.' });
  const composePublicReply = vi.fn<ReplyGenerator['generate']>().mockResolvedValue('Is pickup available?');
  Object.assign(stand.generator, { decide, composePublicReply });
  let h = await Harness.start(env, stand);
  try {
    await h.receive(contact, 'There is a fee before you can begin the job.');
    await h.app.drain();
    expect(stand.sender.to(contact).map(x => x.reply.text)).toEqual(['What does the fee cover?']);
    const trigger = await h.receive(contact, 'The offer expires unless you pay immediately.');
    await h.app.drain();
    const [action] = await h.caseActionsOf(contact, 'telegram_officer_review_requested');
    expect(action).toMatchObject({ messageId: trigger.id, detail: { reason: 'conversation_review',
      reviewStatus: 'READY_FOR_OFFICER_REVIEW', indicators: 'upfront_fee,payment_pressure',
      model: 'test-model', messageEventId: expect.stringMatching(/^mev_/), holdsReplies: false } });
    expect(JSON.stringify(action)).not.toContain(trigger.text);
    expect((await h.chatFor(contact))!.telegramReplyHold.officerReview).toBeNull();
    expect(stand.sender.to(contact).map(x => x.reply.text)).toEqual(['What does the fee cover?', 'Is pickup available?']);
    await h.close();
    stand = standIns(stand.clock);
    Object.assign(stand.generator, { decide, composePublicReply });
    h = await Harness.start(env, stand, h.data);
    await h.receive(contact, 'Are you still there?');
    await h.app.drain();
    expect(decide).toHaveBeenCalledTimes(3);
    expect(composePublicReply).toHaveBeenCalledOnce();
    const chat = (await h.chatFor(contact))!;
    const marked = await h.call('POST', `/v1/chats/${chat.id}/officer-decisions`, {
      decision: 'mark_reviewed', reviewActionId: action!.id, expectedRevision: chat.revision,
    });
    expect(marked.success).toBe(true);
    await h.app.drain();
    expect(decide).toHaveBeenCalledTimes(3);
    expect(stand.sender.to(contact)).toHaveLength(1);
    await h.receive(contact, 'Thanks for clarifying.');
    await h.app.drain();
    expect(stand.sender.to(contact)).toHaveLength(2);
    await h.receive(contact, 'Please stop messaging me.');
    await h.app.drain();
    expect((await h.chatFor(contact))!.telegramReplyHold.contactOptedOut).toBe(true);
    expect(decide).toHaveBeenCalledTimes(4);
    expect(await h.caseActionsOf(contact, 'telegram_officer_review_requested')).toHaveLength(1);
  } finally { await h.stop(); }
});

it('keeps a reviewed sensitive-request warning cleared across Dispatch and fresh DMs', async () => {
  const stand = standIns();
  const sensitive: AliDecision = { kind: 'review', status: 'HUMAN_INTERVENTION_REQUIRED', reasons: ['sensitive_request'] };
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>().mockResolvedValue(sensitive);
  const composePublicReply = vi.fn<ReplyGenerator['generate']>()
    .mockResolvedValueOnce('Can you tell me more about the item?')
    .mockResolvedValueOnce('What color is it?').mockResolvedValue('Thanks for clarifying.');
  Object.assign(stand.generator, { decide, composePublicReply });
  const h = await Harness.start(env, stand);
  try {
    await h.receive(contact, 'Please share your verification code.');
    await h.app.drain();
    const chat = (await h.chatFor(contact))!;
    expect(chat.telegramReplyHold.officerReview).toBeNull();
    const reviewId = chat.telegramReplyHold.evidenceItems[0].actionId;
    expect((await h.call('POST', `/v1/chats/${chat.id}/officer-decisions`, {
      decision: 'mark_reviewed', reviewActionId: reviewId, expectedRevision: chat.revision,
    })).success).toBe(true);
    expect((await h.call('POST', '/v1/dispatches', { chatIds: [chat.id], participantPermissionRecorded: true, replyAgain: true },
      { 'Idempotency-Key': randomUUID() })).data.results[0].telegram.reply).toBe('queued');
    await h.app.drain();
    await h.receive(contact, 'Do you have that code?');
    await h.app.drain();
    expect(stand.sender.to(contact).map(item => item.reply.text))
      .toEqual(['Can you tell me more about the item?', 'What color is it?', 'Thanks for clarifying.']);
    expect((await h.caseActionsOf(contact, 'telegram_officer_review_requested'))
      .filter(action => action.detail.reason === 'conversation_review')).toHaveLength(1);
    expect((await h.chatFor(contact))!.telegramReplyHold.officerReview).toBeNull();
    expect((await h.chatFor(contact))!.telegramReplyHold.evidenceItems).toEqual([]);
  } finally { await h.stop(); }
});

it.each<AliDecision>([
  { kind: 'review', status: 'HUMAN_INTERVENTION_REQUIRED', reasons: ['sensitive_request'] },
  { kind: 'silence', reason: 'no_actionable_question', explanation: 'The sender only shared a link and asked nothing.' },
])('uses the public writer for a link when the assessment returns $kind', async assessment => {
  const stand = standIns();
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>().mockResolvedValue(assessment);
  const reply = 'Is the listing for the same shelf?';
  const composePublicReply = vi.fn<ReplyGenerator['generate']>().mockResolvedValue(reply);
  Object.assign(stand.generator, { decide, composePublicReply });
  const h = await Harness.start(env, stand);
  try {
    const url = 'https://shop.example.test/item/shelf';
    await h.receive(contact, url);
    await h.app.drain();
    expect(decide).toHaveBeenCalledOnce();
    expect(composePublicReply).toHaveBeenCalledOnce();
    const composition = composePublicReply.mock.calls[0]!;
    expect(composition[0]).toContainEqual({ from: 'contact', text: url });
    expect(composition[3]).toContain(url);
    expect(composition[6]?.version).toBeTruthy();
    expect(composition[6]).toBe(decide.mock.calls[0]![6]);
    expect(stand.sender.to(contact).map(item => item.reply.text)).toEqual([reply]);
    expect(await h.caseActionsOf(contact, 'ai_reply_sent')).toMatchObject([{ detail: { source: 'model', model: 'test-model' } }]);
    const chat = (await h.chatFor(contact))!;
    expect(chat.telegramReplyHold.officerReview).toBeNull();
    expect(chat.telegramReplyHold.evidenceItems).toHaveLength(1);
  } finally { await h.stop(); }
});

it.each(['automatic', 'dispatch'] as const)('records a failed %s draft without sending substitute text, then answers the next message', async mode => {
  const stand = standIns();
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>().mockResolvedValueOnce(review)
    .mockResolvedValue({ kind: 'reply', text: 'Which shelf do you mean?' });
  const composePublicReply = vi.fn<ReplyGenerator['generate']>().mockRejectedValue(new ReplyGenerationError('gemini_timeout'));
  Object.assign(stand.generator, { decide, composePublicReply });
  const h = await Harness.start({ ...env, TELEGRAM_AI_AUTO_START: String(mode === 'automatic') }, stand);
  try {
    const trigger = await h.receive(contact, 'There is an urgent fee for the job.');
    if (mode === 'dispatch') {
      const chat = (await h.chatFor(contact))!;
      const dispatch = await h.call('POST', '/v1/dispatches', { chatIds: [chat.id], participantPermissionRecorded: true, replyAgain: true },
        { 'Idempotency-Key': randomUUID() });
      expect(dispatch.data.results[0].telegram.reply).toBe('queued');
    }
    await h.app.drain();
    expect(stand.sender.sent).toHaveLength(0);
    expect(await h.caseActionsOf(contact, 'ai_reply_sent')).toHaveLength(0);
    expect(await h.caseActionsOf(contact, 'ai_reply_failed')).toMatchObject([{ messageId: trigger.id, detail: { code: 'gemini_timeout' } }]);
    expect(await h.caseActionsOf(contact, 'telegram_officer_review_requested')).toMatchObject([
      { messageId: trigger.id, detail: { reason: 'conversation_review', holdsReplies: false } },
    ]);
    expect((await h.chatFor(contact))!.telegramReplyHold.officerReview).toBeNull();
    await h.receive(contact, 'Did you want the shelf instead?');
    await h.app.drain();
    expect(stand.sender.to(contact).map(item => item.reply.text)).toEqual(['Which shelf do you mean?']);
  } finally { await h.stop(); }
});

it('discards a public link reply when bank details arrive while Gemini is writing', async () => {
  const stand = standIns();
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>().mockResolvedValue(review);
  let finish!: (reply: string) => void;
  const composePublicReply = vi.fn<ReplyGenerator['generate']>()
    .mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
  Object.assign(stand.generator, { decide, composePublicReply });
  const h = await Harness.start(env, stand);
  try {
    await h.receive(contact, 'https://shop.example.test/shelf');
    await vi.waitFor(() => expect(composePublicReply).toHaveBeenCalledOnce());
    await h.receive(contact, 'For the bank transfer, my bank account number is 0000000000123456.');
    finish('How wide is the shelf?');
    await h.app.drain();
    expect((await h.chatFor(contact))!.telegramReplyHold.officerReview).toMatchObject({ reason: 'bank_details' });
    expect(stand.sender.sent).toEqual([]);
    expect(await h.caseActionsOf(contact, 'ai_reply_sent')).toEqual([]);
  } finally { await h.stop(); }
});

it.each(['takeover', 'edit', 'deletion', 'opt-out'])('discards a pending review after %s', async change => {
  const stand = standIns();
  let resolve!: (result: AliDecision) => void;
  const decide = vi.fn<() => Promise<AliDecision>>().mockResolvedValue({ kind: 'silence', reason: 'already_answered' })
    .mockImplementationOnce(() => new Promise<AliDecision>(done => { resolve = done; }));
  Object.assign(stand.generator, { decide });
  const h = await Harness.start(env, stand);
  try {
    const first = await h.receive(contact, 'Is this fee normal?');
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
    if (change === 'takeover') await h.control(contact, 'take_over');
    if (change === 'deletion') await h.deleteAtSource(contact, first);
    if (change === 'opt-out') await h.receive(contact, 'Please stop messaging me.');
    if (change === 'edit') {
      const update = incoming(contact, 'I corrected the typo.', stand.clock.now().getTime());
      await h.deliver({ update_id: update.update_id, edited_business_message: {
        ...(update.business_message as object), message_id: first.telegramMessageId,
      } });
      stand.clock.advance(3000);
    }
    resolve(review);
    await h.app.drain();
    expect(await h.caseActionsOf(contact, 'telegram_officer_review_requested')).toEqual([]);
    expect(stand.sender.to(contact)).toEqual([]);
  } finally { await h.stop(); }
});
