import { describe, expect, it } from 'vitest';
import { Harness, incoming, LIVE_BASE_ENV, standIns } from '../helpers/telegram-live-harness.ts';

const contact = 6000000861;
const env = { ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true' };

describe('a contact starts a new conversation after a plain Stop', () => {
  it.each([
    { turn: 'Hi', reply: 'Hello' },
    { turn: 'Can I ask about my receipt?', reply: 'Sure, go ahead.' },
  ])('answers the first new turn "$turn" once after three quiet seconds', async ({ turn, reply }) => {
    const first = standIns();
    let h = await Harness.start(env, first);
    try {
      await h.receive(contact, 'A question from the previous conversation.');
      await h.app.drain();
      expect(first.sender.sent).toHaveLength(1);
      await h.receive(contact, 'Stop');
      await h.receive(contact, 'Thanks.');
      await h.app.drain();
      expect((await h.chatFor(contact))?.telegramReplyHold.contactOptedOut).toBe(true);
      expect(first.generator.histories).toHaveLength(1);

      first.generator.replyNext(reply);
      await h.deliver(incoming(contact, turn, first.clock.now().getTime()));
      const [reopened] = await h.caseActionsOf(contact, 'telegram_contact_opted_in');
      expect(reopened).toMatchObject({ detail: { contactReopened: true } });
      first.clock.advance(2_999);
      await h.app.drain();
      expect(first.sender.to(contact)).toHaveLength(1);
      expect(first.generator.histories).toHaveLength(1);
      first.clock.advance(1);
      await h.app.drain();
      expect(first.sender.to(contact)).toHaveLength(2);
      expect(first.sender.to(contact)[1]?.reply.text).toBe(reply);
      expect(first.generator.histories).toHaveLength(2);
      expect(first.generator.histories[1]).toEqual([{ from: 'contact', text: turn }]);
      expect((await h.caseActionsOf(contact, 'ai_reply_sent')).at(-1)?.detail).toMatchObject({
        inReplyTo: reopened?.messageId, source: 'model', model: 'test-model',
      });

      await h.close();
      const next = standIns(first.clock);
      h = await Harness.start(env, next, h.data);
      next.clock.advance(3_000);
      await h.app.drain();
      expect(next.sender.sent).toHaveLength(0);
      expect(next.generator.histories).toHaveLength(0);
      expect(await h.caseActionsOf(contact, 'ai_reply_sent')).toHaveLength(2);
    } finally {
      await h.stop();
    }
  });

  it('a second Stop during the reopening quiet period cancels the pending reply', async () => {
    const stand = standIns();
    const h = await Harness.start(env, stand);
    try {
      await h.receive(contact, 'Stop');
      await h.deliver(incoming(contact, 'Hello again', stand.clock.now().getTime()));
      expect((await h.chatFor(contact))?.telegramReplyHold.contactOptedOut).toBe(false);
      stand.clock.advance(2_999);
      await h.deliver(incoming(contact, 'Stop', stand.clock.now().getTime()));
      stand.clock.advance(3_000);
      await h.app.drain();
      expect(stand.generator.histories).toHaveLength(0);
      expect(stand.sender.sent).toHaveLength(0);
      expect(await h.caseActionsOf(contact, 'telegram_contact_opted_out')).toHaveLength(2);
      expect((await h.chatFor(contact))?.telegramReplyHold.contactOptedOut).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it.each(['pause', 'take_over'] as const)('leaves officer %s in control when the contact opens a new conversation', async (control) => {
    const stand = standIns();
    const h = await Harness.start(env, stand);
    try {
      await h.receive(contact, 'An ordinary first message.');
      await h.app.drain();
      expect(stand.sender.sent).toHaveLength(1);
      await h.control(contact, control);
      const before = await h.chatFor(contact);
      await h.receive(contact, 'Stop');
      await h.receive(contact, 'Could you help me check an unexpected fee?');
      await h.app.drain();
      const after = await h.chatFor(contact);
      expect(after?.telegramReplyHold.contactOptedOut).toBe(false);
      expect(after).toMatchObject({ aiMode: before?.aiMode, revision: before?.revision, controller: before?.controller });
      expect(stand.sender.sent).toHaveLength(1);
      expect(stand.generator.histories).toHaveLength(1);
    } finally {
      await h.stop();
    }
  });

  it('keeps bank details held when the contact reopens and releases the hold independently of documents', async () => {
    const stand = standIns();
    const h = await Harness.start(env, stand);
    try {
      await h.receive(contact, 'Stop');
      const document = incoming(contact, '', stand.clock.now().getTime());
      Object.assign(document.business_message as object, { document: { file_id: 'synthetic-reopening-file' } });
      await h.deliver(document);
      expect((await h.chatFor(contact))?.telegramReplyHold.officerReview).toBeNull();
      await h.deliver(incoming(contact, 'For the transfer my bank account number is 0000000000123456.', stand.clock.now().getTime()));
      const flag = (await h.chatFor(contact))?.telegramReplyHold.officerReview;
      expect(flag).toMatchObject({ reason: 'bank_details' });
      await h.receive(contact, 'Can I ask a new question?');
      await h.app.drain();
      const chat = await h.chatFor(contact);
      expect(chat?.telegramReplyHold).toMatchObject({ contactOptedOut: false, officerReview: flag });
      expect(chat?.telegramReplyHold.evidenceItems).toHaveLength(2);
      expect(stand.generator.histories).toHaveLength(0);
      expect(stand.sender.sent).toHaveLength(0);
      const resolved = await h.call('POST', `/v1/chats/${chat?.id}/officer-decisions`, {
        decision: 'mark_reviewed', expectedRevision: chat?.revision, reviewActionId: flag.actionId,
      });
      expect(resolved.success).toBe(true);
      const remaining = await h.chatFor(contact);
      expect(remaining?.telegramReplyHold.officerReview).toBeNull();
      const [second] = remaining?.telegramReplyHold.evidenceItems;
      expect(second).toMatchObject({ reason: 'document' });
      const reviewed = await h.call('POST', `/v1/chats/${remaining?.id}/officer-decisions`, {
        decision: 'mark_reviewed', expectedRevision: remaining?.revision, reviewActionId: second.actionId,
      });
      expect(reviewed.success).toBe(true);
      await h.app.drain();
      expect(stand.generator.histories).toHaveLength(0);
      await h.receive(contact, 'Is anyone there now?');
      await h.app.drain();
      expect(stand.sender.sent).toHaveLength(1);
    } finally {
      await h.stop();
    }
  });
});
