import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, incoming, LIVE_BASE_ENV, OWNER_ID, standIns } from '../helpers/telegram-live-harness.ts';

const contact = 6000000801;
const second = 6000000802;
const locationChat = 6000000804;
const stand = standIns();
const now = () => stand.clock.now().getTime();
const env = { ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: [contact, second, locationChat].join(','), TELEGRAM_AI_REPLIES_ENABLED: 'false' };
const optedOut = 'telegram_contact_opted_out';
const optedIn = 'telegram_contact_opted_in';
const flagged = 'telegram_officer_review_requested';

describe('Telegram contact consent and officer review at intake', () => {
  let h: Harness;
  beforeAll(async () => { h = await Harness.start(env, stand); });
  afterAll(async () => { await h.stop(); });

  it('keeps administrative requests, ordinary place mentions, and outgoing evidence out of holds', async () => {
    await h.deliver(
      incoming(contact, 'Stop the testing now', now()),
      incoming(contact, 'Stop asking these questions', now()),
      incoming(contact, 'Our holiday in Test City was nice.', now()),
      incoming(contact, 'What is your address?', now()),
      incoming(contact, 'My address is 12 Example Road', now(), { fromId: OWNER_ID }),
    );
    expect(await h.caseActionsOf(contact, optedOut)).toHaveLength(0);
    expect(await h.caseActionsOf(contact, flagged)).toHaveLength(0);
  });

  it('records one opt-out across redelivery, holds through later chatter, and accepts only an explicit contact re-enrolment', async () => {
    const request = incoming(contact, 'Please don’t message me again!', now());
    await h.deliver(request, request, incoming(contact, 'Ok', now()), incoming(contact, 'I agree to receive automated replies from Mirsad', now(), { fromId: OWNER_ID }));
    expect(await h.caseActionsOf(contact, optedOut)).toHaveLength(1);
    expect(await h.caseActionsOf(contact, optedIn)).toHaveLength(0);
    expect(await h.caseActionsOf(contact, flagged)).toHaveLength(0);
    await h.deliver(incoming(contact, 'I agree to receive automated replies from Mirsad', now()));
    expect(await h.caseActionsOf(contact, optedIn)).toHaveLength(1);
  });

  it('honors natural invitations after a stop, without letting old, forwarded, edited or quoted text reopen the chat', async () => {
    await h.deliver(incoming(contact, 'Stop', now()));
    const stopped = now();
    stand.clock.advance(2_999);
    await h.deliver(incoming(contact, 'Hello again', now()));
    stand.clock.advance(1_000);
    await h.deliver(incoming(contact, 'Can we talk?', now()));
    expect((await h.chatFor(contact))!.telegramReplyHold.contactOptedOut).toBe(true);
    stand.clock.advance(60_000);
    const forward = incoming(contact, 'Hello', now());
    Object.assign(forward.business_message as object, { forward_origin: { type: 'hidden_user' } });
    const quote = incoming(contact, 'Can you reply?', now());
    Object.assign(quote.business_message as object, { entities: [{ type: 'blockquote', offset: 0, length: 14 }] });
    const plain = incoming(contact, 'Noted', now());
    const edit = { update_id: incoming(contact, '', now()).update_id, edited_business_message: {
      ...plain.business_message as object, text: 'Can you reply?', edit_date: Math.floor(now() / 1000) } };
    await h.deliver(forward, quote, plain, edit, incoming(contact, '“Can you reply?”', now()),
      incoming(contact, 'Why are you still messaging me?', now()), incoming(contact, 'Hi', stopped - 1_000));
    expect((await h.chatFor(contact))!.telegramReplyHold.contactOptedOut).toBe(true);
    const invite = incoming(contact, 'السلام عليكم', now());
    await h.deliver(invite, invite);
    expect((await h.chatFor(contact))!.telegramReplyHold.contactOptedOut).toBe(false);
    expect((await h.caseActionsOf(contact, optedIn)).filter(a => a.detail.contactReopened)).toHaveLength(1);
  });

  it('requires a direct invitation after an emphatic stop and preserves outstanding officer review', async () => {
    await h.deliver(incoming(contact, 'Never contact me again', now()));
    stand.clock.advance(60_000);
    await h.deliver(incoming(contact, 'Hi', now()));
    expect((await h.chatFor(contact))!.telegramReplyHold.contactOptedOut).toBe(true);
    await h.deliver(incoming(contact, 'ليش للحين تردون علي؟', now()));
    expect((await h.chatFor(contact))!.telegramReplyHold.contactOptedOut).toBe(true);
    const document = incoming(contact, '', now());
    Object.assign(document.business_message as object, { document: { file_id: 'synthetic-doc' } });
    await h.deliver(document, incoming(contact, 'Can we talk again?', now()));
    expect((await h.chatFor(contact))!.telegramReplyHold).toMatchObject({ contactOptedOut: false, officerReview: null, evidenceItems: [{ reason: 'document' }] });
  });

  it.each([
    'Hi again', 'I’d like to talk again', 'I have another offer for you', "I’m selling a desk if you're interested",
    'Are you still looking for an apartment', 'وين صار الطلب', 'عندي عرض جديد لك',
  ])('accepts fresh, directly addressed conversation after an ordinary stop: %s', async opening => {
    await h.deliver(incoming(locationChat, 'Stop messaging me', now()));
    stand.clock.advance(5_000);
    await h.deliver(incoming(locationChat, 'Why are you still sending me messages?', now()));
    expect((await h.chatFor(locationChat))!.telegramReplyHold.contactOptedOut).toBe(true);
    await h.deliver(incoming(locationChat, opening, now()));
    expect((await h.chatFor(locationChat))!.telegramReplyHold.contactOptedOut).toBe(false);
  });

  it('flags each volunteered document, map pin or contextual street address with its source, including edits', async () => {
    const doc = incoming(second, '', now());
    Object.assign(doc.business_message as object, { document: { file_id: 'never-fetch-file', file_name: 'private-name.pdf' } });
    const loc = incoming(second, '', now());
    Object.assign(loc.business_message as object, { location: { latitude: 1.23, longitude: 2.34 } });
    const original = incoming(second, 'I have an update.', now());
    const edit = incoming(second, '', now());
    const edited = { update_id: edit.update_id, edited_business_message: { ...(original.business_message as object), text: '', document: { file_id: 'never-fetch-edit' }, edit_date: Math.floor(now() / 1000) } };
    await h.deliver(doc, doc, loc, incoming(second, 'The transfer office is at 12 Example Road.', now()), original, edited);
    const actions = await h.caseActionsOf(second, flagged);
    expect(actions.map(a => a.detail.reason).sort()).toEqual(['document', 'document', 'location', 'location']);
    for (const action of actions) {
      expect(action.messageId).toMatch(/^msg_/);
      expect(action.detail.messageEventId).toMatch(/^mev_/);
      expect(Object.keys(action.detail).sort()).toEqual(['holdsReplies', 'messageEventId', 'reason']);
    }
    expect(h.logs.join('\n')).not.toMatch(/never-fetch|private-name|Example Road/);
  });

  it('distinguishes supplied places in English and Arabic from a casual mention or a request for an address', async () => {
    const relevant = [
      'We are at 14 Example Street.',
      'The pickup location is Example Mall.',
      'موقعي في مول المثال.',
      'عنوان الشقة هو شارع المثال بناية ٢٢.',
      'Here is the pin https://maps.app.goo.gl/example123',
      'Coordinates: 24.123456, 54.987654',
      'The pickup is at 12 Oak Street. Is that enough?',
    ];
    const unrelated = ['I like Example Mall.', 'هل تعرف شارع المثال؟', 'Where is 14 Example Street?', 'My address is private.',
      'The pickup point for that parcel is still undecided. I like Example Station, Gate 4.',
      'Is the pickup point for that parcel Example Station, Gate 4?',
      'The pickup point for that parcel is not Example Station, Gate 4.',
      'They said the pickup point for that parcel is Example Station, Gate 4.',
      'An example sentence is “The pickup point for that parcel is Example Station, Gate 4.”',
      'No need to send documents.', 'https://maps.app.goo.gl.example.test/xyz', 'Is the pickup at 12 Oak Street?'];
    await h.deliver(...[...relevant, ...unrelated].map(text => incoming(locationChat, text, now())));
    const timeline = await h.timelineOf(locationChat);
    const actions = await h.caseActionsOf(locationChat, flagged);
    const textsFor = (reason: string) => {
      const ids = new Set(actions.filter(a => a.detail.reason === reason).map(a => a.messageId));
      return timeline.messages.filter((m: { id: string }) => ids.has(m.id)).map((m: { text: string }) => m.text).sort();
    };
    // A map URL, genuine or a look-alike host, is a link warning like any other URL; only supplied places are locations.
    const pin = 'Here is the pin https://maps.app.goo.gl/example123';
    expect(textsFor('location')).toEqual(relevant.filter(text => text !== pin).sort());
    expect(textsFor('link')).toEqual([pin, 'https://maps.app.goo.gl.example.test/xyz'].sort());
  });
});

describe('contact boundaries take effect before a queued reply', () => {
  it.each([
    { kind: 'opt-out', message: 'Actually please leave me alone.' },
    { kind: 'opt-out', message: 'خلاص اتركني بحالي ولا ترسل لي رسائل' },
    { kind: 'opt-out', message: 'خلاص لا ترد علي مرة ثانية.' },
    { kind: 'location', message: 'The pickup point for that parcel is Example Station, Gate 4.' },
  ])('honors $kind from the incoming message "$message"', async ({ kind, message }) => {
    const stand = standIns();
    const h = await Harness.start({ ...env, TELEGRAM_AI_REPLIES_ENABLED: 'true', TELEGRAM_AI_AUTO_START: 'true' }, stand);
    try {
      await h.deliver(incoming(contact, 'Hi', stand.clock.now().getTime()));
      stand.clock.advance(1_000);
      const trigger = await h.receive(contact, message);
      await h.app.drain();
      const hold = (await h.chatFor(contact))?.telegramReplyHold;
      if (kind === 'location') {
        expect(stand.sender.sent).toHaveLength(1);
        expect(stand.generator.histories).toHaveLength(1);
        expect(hold).toMatchObject({ contactOptedOut: false, officerReview: null, evidenceItems: [{ reason: 'location', messageId: trigger.id }] });
      } else {
        expect(stand.sender.sent).toHaveLength(0);
        expect(stand.generator.histories).toHaveLength(0);
        expect(hold).toEqual({ contactOptedOut: true, officerReview: null, evidenceItems: [] });
        expect(await h.caseActionsOf(contact, optedOut)).toMatchObject([{ messageId: trigger.id }]);
      }
    } finally {
      await h.stop();
    }
  });
});
