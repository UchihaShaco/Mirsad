import { expect, it, vi } from 'vitest';
import type { AliDecision } from '../../src/replies/ali-decision.ts';
import { Harness, incoming, LIVE_BASE_ENV, standIns } from '../helpers/telegram-live-harness.ts';

const contact = 6000000889;
const env = { ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true' };
const review: AliDecision = { kind: 'review', status: 'READY_FOR_OFFICER_REVIEW', reasons: ['upfront_fee', 'payment_pressure'] };

it('delivers ordinary replies, queues the threshold locally, and requires an officer to reopen future turns', async () => {
  let stand = standIns();
  const decide = vi.fn<() => Promise<AliDecision>>()
    .mockResolvedValueOnce({ kind: 'reply', text: 'What does the fee cover?' })
    .mockResolvedValueOnce(review)
    .mockResolvedValue({ kind: 'reply', text: 'Understood.' });
  Object.assign(stand.generator, { decide });
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
      model: 'test-model', messageEventId: expect.stringMatching(/^mev_/), holdsReplies: true } });
    expect(JSON.stringify(action)).not.toContain(trigger.text);
    expect((await h.chatFor(contact))!.telegramReplyHold.officerReview.actionId).toBe(action!.id);
    expect(stand.sender.to(contact)).toHaveLength(1);
    await h.close();
    stand = standIns(stand.clock);
    Object.assign(stand.generator, { decide });
    h = await Harness.start(env, stand, h.data);
    await h.receive(contact, 'Are you still there?');
    await h.app.drain();
    expect(decide).toHaveBeenCalledTimes(2);
    const chat = (await h.chatFor(contact))!;
    const marked = await h.call('POST', `/v1/chats/${chat.id}/officer-decisions`, {
      decision: 'mark_reviewed', reviewActionId: action!.id, expectedRevision: chat.revision,
    });
    expect(marked.success).toBe(true);
    await h.app.drain();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(stand.sender.to(contact)).toHaveLength(0);
    await h.receive(contact, 'Thanks for clarifying.');
    await h.app.drain();
    expect(stand.sender.to(contact)).toHaveLength(1);
    await h.receive(contact, 'Please stop messaging me.');
    await h.app.drain();
    expect((await h.chatFor(contact))!.telegramReplyHold.contactOptedOut).toBe(true);
    expect(decide).toHaveBeenCalledTimes(3);
    expect(await h.caseActionsOf(contact, 'telegram_officer_review_requested')).toHaveLength(1);
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
