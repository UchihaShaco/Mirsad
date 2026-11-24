import { expect, it, vi } from 'vitest';
import type { AliDecision } from '../../src/replies/ali-decision.ts';
import type { ReplyGenerator } from '../../src/replies/reply-generator.ts';
import { Harness, incoming, LIVE_BASE_ENV, standIns, WAIT } from '../helpers/telegram-live-harness.ts';

const contact = 6000000892;
const env = { ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true' };
const linkedText = 'The same-day registration fee is described on this page: https://registration.example.test/current?ref=synthetic-link-reference';
const flaggedDraft: AliDecision = { kind: 'reply', text: 'Could you explain the fee?',
  paymentLinkReview: { candidateId: 1, reason: 'unverified_payment_request' } };

it('delivers a Gemini reply alongside its link warning and remembers the reviewed URL', async () => {
  const stand = standIns();
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>()
    .mockResolvedValueOnce({ kind: 'silence', reason: 'no_actionable_question', explanation: 'The sender only shared a page and asked nothing.' })
    .mockResolvedValueOnce(flaggedDraft)
    .mockResolvedValue({ kind: 'silence', reason: 'already_answered' });
  const composePublicReply = vi.fn<ReplyGenerator['generate']>()
    .mockResolvedValueOnce('What is the registration for?').mockResolvedValue('Is there another way to register?');
  Object.assign(stand.generator, { decide, composePublicReply });
  const h = await Harness.start(env, stand);
  try {
    const source = await h.receive(contact, linkedText);
    await h.app.drain();
    const trigger = await h.receive(contact, 'You need to do it in the next five minutes.');
    await h.app.drain();
    const modelContext = decide.mock.calls.at(1)?.[5];
    expect(modelContext?.paymentLinks).toEqual([{
      id: 1, host: 'registration.example.test', excerpt: 'The same-day registration fee is described on this page: [candidate link]',
    }]);
    const actions = await h.caseActionsOf(contact, 'telegram_officer_review_requested');
    const action = actions.find(item => item.detail.reason === 'model_payment_link');
    expect(action).toMatchObject({ messageId: source.id,
      detail: { reason: 'model_payment_link', indicators: 'unverified_payment_request', triggerMessageId: trigger.id,
        messageEventId: expect.stringMatching(/^mev_/u), holdsReplies: false } });
    expect(JSON.stringify(action)).not.toContain('synthetic-link-reference');
    const chat = (await h.chatFor(contact))!;
    expect(chat.telegramReplyHold).toMatchObject({ officerReview: null,
      evidenceItems: [{ messageId: source.id, messageEventId: action!.detail.messageEventId }] });
    expect(stand.sender.to(contact).map(item => item.reply.text)).toEqual(['What is the registration for?', 'Could you explain the fee?']);
    expect(composePublicReply).toHaveBeenCalledOnce();
    const reviewed = await h.call('POST', `/v1/chats/${chat.id}/officer-decisions`, {
      decision: 'mark_reviewed', reviewActionId: action!.id, expectedRevision: chat.revision,
    });
    expect(reviewed.success).toBe(true);
    expect((await h.chatFor(contact))!.telegramReplyHold.officerReview).toBeNull();
    await h.receive(contact, linkedText);
    await h.app.drain();
    expect(decide.mock.calls.at(2)?.[5]?.paymentLinks).toEqual([]);
    expect(await h.caseActionsOf(contact, 'telegram_officer_review_requested')).toHaveLength(actions.length);
    expect((await h.chatFor(contact))!.telegramReplyHold.evidenceItems).toEqual([]);
  } finally { await h.stop(); }
});

it('rejects an invented payment citation, records a conversation warning and continues the turn', async () => {
  const stand = standIns();
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>().mockResolvedValue({
    kind: 'review', status: 'HUMAN_INTERVENTION_REQUIRED', reasons: ['uncertain'],
    paymentLinkReview: { candidateId: 9, reason: 'unverified_payment_request' },
  });
  const composePublicReply = vi.fn<ReplyGenerator['generate']>().mockResolvedValue('Which conditions changed?');
  Object.assign(stand.generator, { decide, composePublicReply });
  const h = await Harness.start(env, stand);
  try {
    const trigger = await h.receive(contact, 'There are some conflicting conditions.');
    await h.app.drain();
    expect(decide.mock.calls[0]?.[5]?.paymentLinks).toEqual([]);
    const actions = await h.caseActionsOf(contact, 'telegram_officer_review_requested');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ messageId: trigger.id, detail: { reason: 'conversation_review', indicators: 'uncertain', holdsReplies: false } });
    expect(stand.sender.to(contact).map(item => item.reply.text)).toEqual(['Which conditions changed?']);
    expect((await h.chatFor(contact))!.telegramReplyHold.officerReview).toBeNull();
  } finally { await h.stop(); }
});

it('requires one officer review when the model flags an already captured payment link', async () => {
  const stand = standIns();
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>().mockResolvedValue(flaggedDraft);
  Object.assign(stand.generator, { decide });
  const h = await Harness.start(env, stand);
  try {
    await h.receive(contact, 'Use the payment link: https://checkout.example.test/order');
    await h.app.drain();
    const actions = await h.caseActionsOf(contact, 'telegram_officer_review_requested');
    expect(actions.map(action => action.detail.reason)).toEqual(['payment_link', 'model_payment_link']);
    const chat = (await h.chatFor(contact))!;
    const [{ actionId, reason }] = chat.telegramReplyHold.evidenceItems;
    expect(chat.telegramReplyHold.evidenceItems).toHaveLength(1);
    expect(chat.telegramReplyHold.officerReview).toBeNull();
    expect(stand.sender.to(contact)).toHaveLength(1);
    expect(reason).toBe('model_payment_link');
    const reviewed = await h.call('POST', `/v1/chats/${chat.id}/officer-decisions`, {
      decision: 'mark_reviewed', reviewActionId: actionId, expectedRevision: chat.revision,
    });
    expect(reviewed.success).toBe(true);
    expect((await h.chatFor(contact))!.telegramReplyHold).toMatchObject({ officerReview: null, evidenceItems: [] });
  } finally { await h.stop(); }
});

it('discards a link flag when its source changes while the model is drafting', async () => {
  const stand = standIns();
  let resolve!: (result: AliDecision) => void;
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>()
    .mockImplementationOnce(() => new Promise<AliDecision>(done => { resolve = done; }))
    .mockResolvedValue({ kind: 'silence', reason: 'no_actionable_question', explanation: 'The sender corrected the fee and asked nothing.' });
  Object.assign(stand.generator, { decide });
  const h = await Harness.start(env, stand);
  try {
    const source = await h.receive(contact, linkedText);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1), WAIT);
    const edit = incoming(contact, 'Correction: there is no registration fee.', stand.clock.now().getTime());
    await h.deliver({ update_id: edit.update_id, edited_business_message: {
      ...(edit.business_message as object), message_id: source.telegramMessageId,
    } });
    stand.clock.advance(3000);
    resolve(flaggedDraft);
    await h.app.drain();
    expect((await h.caseActionsOf(contact, 'telegram_officer_review_requested'))
      .filter(action => action.detail.reason === 'model_payment_link')).toEqual([]);
    expect(stand.sender.to(contact)).toEqual([]);
  } finally { await h.stop(); }
});

it('supplies dispatch context separately from the eligible conversation and log', async () => {
  const stand = standIns();
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>()
    .mockResolvedValue({ kind: 'reply', text: 'Could you tell me what the registration covers?' });
  Object.assign(stand.generator, { decide });
  const h = await Harness.start({ ...env, TELEGRAM_AI_AUTO_START: 'false' }, stand);
  try {
    await h.receive(contact, 'Hello, the registration is open.');
    await h.app.drain();
    expect(decide).not.toHaveBeenCalled();
    const chat = (await h.chatFor(contact))!;
    const officerContext = 'Check the reported registration fee hypothesis. Brief-only synthetic marker.';
    const dispatched = await h.call('POST', '/v1/dispatches', { chatIds: [chat.id], officerContext },
      { 'Idempotency-Key': 'test-dispatch-with-brief' });
    expect(dispatched.success).toBe(true);
    await h.app.drain();
    expect(decide.mock.calls[0]?.[5]).toEqual({ dispatchBrief: officerContext, dispatchIntent: 'reply', paymentLinks: [] });
    expect(JSON.stringify(decide.mock.calls[0]?.[0])).not.toContain(officerContext);
    expect(JSON.stringify(await h.caseActionsOf(contact, 'dispatch_started'))).not.toContain(officerContext);
    expect(h.logs.join('\n')).not.toContain(officerContext);
  } finally { await h.stop(); }
});
