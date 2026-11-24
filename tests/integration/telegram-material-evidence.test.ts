import { describe, expect, it, vi } from 'vitest';
import { Harness, incoming, LIVE_BASE_ENV, OWNER_ID, standIns } from '../helpers/telegram-live-harness.ts';

const contact = 6000000866;
const env = { ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true' };
const payment = 'https://pay.synthetic.test/checkout/initial';

describe('voluntarily shared material in an enrolled chat', () => {
  it('holds at two, deduplicates edits and reposts across restart, and releases only after officer review', async () => {
    const stand = standIns();
    let h = await Harness.start(env, stand);
    const now = () => stand.clock.now().getTime();
    const state = async () => (await h.chatFor(contact))!.telegramReplyHold;
    const resolve = async (actionId: string) => {
      const chat = (await h.chatFor(contact))!;
      return h.call('POST', `/v1/chats/${chat.id}/officer-decisions`, {
        decision: 'mark_reviewed', reviewActionId: actionId, expectedRevision: chat.revision,
      });
    };
    try {
      const shared = incoming(contact, 'Here is my payment link: ' + payment, now());
      await h.deliver(shared, shared);
      const first = (await state()).evidenceItems[0];
      expect(await state()).toMatchObject({ officerReview: null, evidenceItems: [{ reason: 'payment_link', messageEventId: expect.stringMatching(/^mev_/) }] });
      expect((await resolve(first.actionId)).error.code).toBe('invalid_transition');
      stand.clock.advance(3000);
      await h.app.drain();
      expect(stand.sender.to(contact)).toHaveLength(1);
      const corrected = 'https://checkout.synthetic.test/invoice/corrected';
      const original = shared.business_message as object;
      const edited = { update_id: incoming(contact, '', now()).update_id, edited_business_message: {
        ...original, text: 'Correction, here is my payment link: ' + corrected, edit_date: Math.floor(now() / 1000),
      } };
      await h.deliver(edited, incoming(contact, payment, now()), incoming(contact, corrected, now()));
      expect((await state()).evidenceItems).toEqual([first]);
      const doc = incoming(contact, 'My invoice', now());
      Object.assign(doc.business_message as object, { document: { file_id: 'private-file-canary' } });
      await h.deliver(doc, doc);
      const hold = await state();
      expect(hold.evidenceItems.map((item: {reason:string}) => item.reason)).toEqual(['payment_link', 'document']);
      expect(hold.officerReview.actionId).toBe(first.actionId);
      await h.receive(contact, 'Is anyone there?');
      await h.app.drain();
      expect(stand.sender.to(contact)).toHaveLength(1);
      await h.close();
      h = await Harness.start(env, standIns(stand.clock), h.data);
      expect(await state()).toEqual(hold);
      expect((await resolve(hold.evidenceItems[1].actionId)).success).toBe(true);
      expect((await state()).officerReview.actionId).toBe(first.actionId);
      expect((await resolve(first.actionId)).success).toBe(true);
      expect((await resolve(first.actionId)).data.created).toBe(false);
      expect(await state()).toEqual({ contactOptedOut: false, officerReview: null, evidenceItems: [] });
      await h.deliver({ ...edited, update_id: incoming(contact, '', now()).update_id });
      expect((await state()).evidenceItems).toHaveLength(0);
      await h.deliver(incoming(contact, corrected, now()));
      expect(await state()).toMatchObject({ officerReview: null, evidenceItems: [{ reason: 'payment_link' }] });
      const timeline = await h.timelineOf(contact);
      expect(timeline.findings).toEqual([]);
      const audit = JSON.stringify(timeline.caseActions);
      for (const value of [payment, corrected, 'private-file-canary']) {
        expect(audit).not.toContain(value);
        expect(h.logs.join('')).not.toContain(value);
      }
    } finally { await h.stop(); }
  });

  it('ignores fee talk, quoted and forwarded material, information pages, casual locations and owner messages', async () => {
    const stand = standIns();
    const h = await Harness.start(env, stand);
    const now = stand.clock.now().getTime();
    try {
      const forwarded = incoming(contact, payment, now);
      Object.assign(forwarded.business_message as object, { forward_origin: { type: 'hidden_user' }, document: { file_id: 'private' } });
      const quote = incoming(contact, 'Here is a payment link: ' + payment, now);
      Object.assign(quote.business_message as object, { entities: [{ type: 'blockquote', offset: 0, length: 10 }] });
      const edit = { update_id: incoming(contact, '', now).update_id, edited_business_message: {
        ...quote.business_message as object, text: payment, edit_date: Math.floor(now / 1000),
      } };
      await h.deliver(forwarded, quote, edit, incoming(contact, payment, now, { fromId: OWNER_ID }),
        ...['The onboarding charge is for a badge.', 'عليك رسوم بداية عشان يطبعون لك البطاقة.',
          'The event is free. Our calendar is https://events.synthetic.test/schedule',
          'Fees apply; read https://synthetic.test/privacy-policy', 'Read https://pay.synthetic.test/support/help',
          'Is this payment link safe? ' + payment, 'They sent me this payment link: ' + payment,
          'The text says “' + payment + '”.', 'I was shopping at Example Station.'].map(text => incoming(contact, text, now)));
      expect((await h.chatFor(contact))?.telegramReplyHold).toEqual({ contactOptedOut: false, officerReview: null, evidenceItems: [] });
      await h.deliver(incoming(contact, 'رابط الدفع https://synthetic.test/code/one', now),
        incoming(contact, 'The pickup point for that parcel is Example Station, Gate 4.', now));
      const hold = (await h.chatFor(contact))!.telegramReplyHold;
      expect(hold.evidenceItems.map((item: {reason:string}) => item.reason)).toEqual(['payment_link','location']);
      expect(hold.officerReview.reason).toBe('payment_link');
    } finally { await h.stop(); }
  });

  it('associates payment context with the supplied destination and counts different destinations separately', async () => {
    const stand = standIns();
    const h = await Harness.start(env, stand);
    try {
      const now = stand.clock.now().getTime();
      await h.deliver(incoming(contact,
        'Here is the payment link: https://synthetic.test/a and our catalogue is https://synthetic.test/b', now));
      let hold = (await h.chatFor(contact))!.telegramReplyHold;
      expect(hold.evidenceItems).toHaveLength(1);
      expect(hold.officerReview).toBe(null);
      await h.deliver(incoming(contact, 'رابط الدفع:\nhttps://synthetic.test/second', now));
      hold = (await h.chatFor(contact))!.telegramReplyHold;
      expect(hold.evidenceItems.map((item: {reason:string}) => item.reason)).toEqual(['payment_link','payment_link']);
      expect(hold.officerReview.reason).toBe('payment_link');
    } finally { await h.stop(); }
  });

  it.each([
    ['For the bank transfer, my bank account number is 0000000000123456.', '0000000000123456'],
    ['للتحويل رقم حسابي البنكي هو ٠٠٠٠٠٠١٢٣٤٥٦', '٠٠٠٠٠٠١٢٣٤٥٦'],
    ['For the payment, my IBAN is GB00 FAKE 0000 0000 0000 00.', 'GB00 FAKE'],
    ['Transfer to GB94 FAKE 0000 0000 0000 00.', 'GB94 FAKE'],
    ['حساب المستفيد للتحويل: AE000000000000000000123', 'AE000000000000000000123'],
  ])('immediately holds a volunteered recipient, cancels a pending draft and excludes the source from later prompts: %s', async (text, canary) => {
    const stand = standIns();
    const h = await Harness.start(env, stand);
    try {
      stand.generator.holdNext();
      await h.receive(contact, 'How long does the course take?');
      await vi.waitFor(() => expect(stand.generator.histories).toHaveLength(1));
      const bank = incoming(contact, text, stand.clock.now().getTime());
      await h.deliver(bank, bank);
      stand.generator.releaseHeld();
      await h.app.drain();
      expect(stand.sender.sent).toHaveLength(0);
      const chat = (await h.chatFor(contact))!;
      const hold = chat.telegramReplyHold;
      expect(hold.evidenceItems).toMatchObject([{ reason: 'bank_details' }]);
      expect(hold.officerReview).toMatchObject({ actionId: hold.evidenceItems[0].actionId, reason: 'bank_details' });
      const timeline = await h.timelineOf(contact);
      expect(timeline.messages.some((m: {text: string}) => m.text === text)).toBe(true);
      expect(JSON.stringify([hold,timeline.caseActions,h.logs])).not.toContain(canary);
      await h.receive(contact, text + ' ');
      expect((await h.chatFor(contact))?.telegramReplyHold.evidenceItems).toHaveLength(1);
      const resolved = await h.call('POST', `/v1/chats/${chat.id}/officer-decisions`, {
        decision: 'mark_reviewed', reviewActionId: hold.officerReview.actionId, expectedRevision: chat.revision,
      });
      expect(resolved.success).toBe(true);
      await h.receive(contact, 'Which days do the sessions run?');
      await h.app.drain();
      expect(stand.sender.sent).toHaveLength(1);
      expect(JSON.stringify(stand.generator.histories)).not.toContain(canary);
    } finally {
      stand.generator.releaseHeld();
      await h.stop();
    }
  });

  it('leaves questions, masks, quoted details, warnings, routing-only, card and credential references outside bank review', async () => {
    const stand = standIns();
    const h = await Harness.start(env, stand);
    const now = stand.clock.now().getTime();
    try {
      await h.deliver(...[
        'Should I send the fee to bank account number 000000123456?', 'I forgot my bank account number.',
        'For the transfer my masked account ends in 3456.', 'Pay to account number 000000xxxx.',
        'Never transfer to account number 000000123456.', 'Do not pay to bank account number 000000123456.',
        'They sent me this: bank transfer to account number 000000123456.',
        'The example says “bank transfer to account number 000000123456”.',
        'Bank transfer to routing number 011000000.', 'For the payment my card number is 4000000000000002.',
        'For the transfer my verification code is 000123.', 'هل أحول على رقم الحساب ٠٠٠٠٠٠١٢٣٤٥٦؟',
        'For your payment use this booking reference GB00BOOKING0000001.',
        'For the transfer this is not my bank account number 000000123456.',
        'للتحويل ليس رقم حسابي البنكي ٠٠٠٠٠٠١٢٣٤٥٦.',
        'لا تحول على رقم الحساب ٠٠٠٠٠٠١٢٣٤٥٦', 'للتحويل رقم البطاقة هو ٤٠٠٠٠٠٠٠٠٠٠٠٠٠٠٢',
      ].map(text => incoming(contact,text,now)));
      expect((await h.chatFor(contact))?.telegramReplyHold).toEqual({ contactOptedOut: false, officerReview: null, evidenceItems: [] });
    } finally { await h.stop(); }
  });
});
