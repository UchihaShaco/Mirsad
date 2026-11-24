import { expect, it, vi } from 'vitest';
import type { ReplyGenerator } from '../../src/replies/reply-generator.ts';
import { Harness, incoming, LIVE_BASE_ENV, standIns, WAIT } from '../helpers/telegram-live-harness.ts';

const env = {
  ...LIVE_BASE_ENV,
  TELEGRAM_CHAT_SCOPE: 'all_private',
  TELEGRAM_ALL_CHATS_REFERENCE: 'TEST-PRIVATE-DMS',
  TELEGRAM_APPROVED_CHAT_IDS: '6000000710',
  TELEGRAM_AI_AUTO_START: 'false',
};

it.each([
  { minutes: 20, reachesModel: true, delayAtModel: 0, sent: true },
  { minutes: 24 * 60 - 1, reachesModel: true, delayAtModel: 60_000, sent: false },
  { minutes: 24 * 60, reachesModel: false, delayAtModel: 0, sent: false },
])('limits officer catch-up at claim and send ($minutes minutes old, $delayAtModel ms delay)', async scenario => {
  const contact = 6000000794;
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    await setReplies(h, true);
    await h.call('POST', '/v1/telegram/consent-prompt', { enabled: false });
    await h.receive(contact, 'Is this desk still available?');
    await h.app.drain();
    stand.clock.advance(scenario.minutes * 60_000);
    const chat = (await h.chatFor(contact))!;
    if (scenario.delayAtModel) stand.generator.holdNext();
    expect((await h.call('POST', '/v1/dispatches', { chatIds: [chat.id], participantPermissionRecorded: true, expectedTestMode: true },
      { 'Idempotency-Key': 'dispatch-window' })).success).toBe(true);
    if (scenario.reachesModel) await vi.waitFor(() => expect(stand.generator.histories).toHaveLength(1), WAIT);
    if (scenario.delayAtModel) {
      stand.clock.advance(scenario.delayAtModel);
      stand.generator.releaseHeld();
    }
    await h.app.drain();
    expect(stand.generator.histories).toHaveLength(scenario.reachesModel ? 1 : 0);
    expect(stand.sender.sent).toHaveLength(scenario.sent ? 1 : 0);
  } finally {
    stand.generator.releaseHeld();
    await h.stop();
  }
});

async function setReplies(h: Harness, enabled: boolean) {
  const result = await h.call('POST', '/v1/telegram/dm-replies', { enabled });
  expect(result.success, JSON.stringify(result.error)).toBe(true);
}

// Wait for this specific update even when the same text was sent earlier.
async function deliver(h: Harness, contact: number, text: string) {
  await h.deliver(incoming(contact, text, h.stand.clock.now().getTime()));
  h.stand.clock.advance(3_000);
  await h.app.drain();
}

it.each(['I AGREE', 'أوافق'])('uses only post-consent messages after the contact replies %s', async (consent) => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  const contact = 6000000711;
  try {
    await setReplies(h, true);
    // Agreement before receiving the notice is only an opening message.
    await deliver(h, contact, consent);
    await vi.waitFor(async () => {
      const notices = await h.caseActionsOf(contact, 'ai_reply_sent');
      expect(notices.some(action => action.detail.source === 'consent_notice')).toBe(true);
    }, WAIT);
    const notice = stand.sender.to(contact)[0]?.reply.text;
    expect(notice).toMatch(/I AGREE/i);
    expect(notice).toContain('أوافق');
    expect(stand.generator.histories).toHaveLength(0);
    expect((await h.chatFor(contact))?.aiMode).toBe('not_started');
    expect(await h.caseActionsOf(contact, 'ai_auto_started')).toHaveLength(0);

    const privateOpening = 'I have a blue sample telescope from before enrolment.';
    await deliver(h, contact, privateOpening);
    expect(stand.generator.histories).toHaveLength(0);
    await deliver(h, contact, consent);
    expect(stand.generator.histories).toHaveLength(0);
    const turn = 'Would you like the height of the cabinet?';
    stand.generator.replyNext('How tall is the cabinet?');
    await deliver(h, contact, turn);
    expect(stand.generator.histories).toHaveLength(0);
    await h.dispatch(contact);
    await vi.waitFor(() => expect(stand.sender.to(contact).some(sent => sent.reply.text === 'How tall is the cabinet?')).toBe(true), WAIT);
    expect(stand.generator.histories).toEqual([[{ from: 'contact', text: turn }]]);
    expect(stand.generator.currentTurns).toEqual([[turn]]);
  } finally {
    await h.stop();
  }
}, 30_000);

it('excludes an older Telegram message delivered after acceptance in the same second from the trigger, context and offer memory', async () => {
  const stand = standIns();
  const generator: ReplyGenerator = stand.generator;
  const generate = vi.spyOn(generator, 'generate');
  const h = await Harness.start(env, stand);
  const contact = 6000000713;
  try {
    await setReplies(h, true);
    await deliver(h, contact, 'Hello.');
    await vi.waitFor(async () => expect((await h.caseActionsOf(contact, 'ai_reply_sent'))
      .some(action => action.detail.source === 'consent_notice')).toBe(true), WAIT);
    await h.dispatch(contact);

    const sentAt = stand.clock.now().getTime();
    const privateOffer = 'I am selling a bamboo chair.';
    // Telegram allocated the offer's message ID before the acceptance. Its update arrives afterwards.
    const delayed = incoming(contact, privateOffer, sentAt);
    await deliver(h, contact, 'I AGREE');
    const laterUpdate = incoming(contact, privateOffer, sentAt);
    await h.deliver({ ...delayed, update_id: laterUpdate.update_id });
    stand.clock.advance(3_000);
    await h.app.drain();
    expect((await h.timelineOf(contact)).messages.some((message: {text: string}) => message.text === privateOffer)).toBe(true);
    expect(generate).not.toHaveBeenCalled();

    const turn = 'Are you available today?';
    await deliver(h, contact, turn);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1), WAIT);
    const [history, , , currentTurn, memory] = generate.mock.calls[0]!;
    expect(history).toEqual([{ from: 'contact', text: turn }]);
    expect(currentTurn).toEqual([turn]);
    expect(memory).toBeUndefined();
  } finally {
    await h.stop();
  }
}, 30_000);

it('requires a fresh agreement after STOP when an earlier agreement arrives late from the same Telegram second', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  const contact = 6000000714;
  try {
    await setReplies(h, true);
    await deliver(h, contact, 'Hello.');
    await vi.waitFor(async () => expect((await h.caseActionsOf(contact, 'ai_reply_sent'))
      .some(action => action.detail.source === 'consent_notice')).toBe(true), WAIT);
    await h.dispatch(contact);
    await deliver(h, contact, 'أوافق');

    const sentAt = stand.clock.now().getTime();
    const delayed = incoming(contact, 'I AGREE', sentAt);
    await deliver(h, contact, 'STOP');
    const laterUpdate = incoming(contact, 'I AGREE', sentAt);
    await h.deliver({ ...delayed, update_id: laterUpdate.update_id });
    stand.clock.advance(3_000);
    await h.app.drain();
    await deliver(h, contact, 'Are you there?');
    expect(stand.generator.histories).toHaveLength(0);

    await deliver(h, contact, 'I AGREE');
    expect(stand.generator.histories).toHaveLength(0);
    const turn = 'Do you have time today?';
    await deliver(h, contact, turn);
    await vi.waitFor(() => expect(stand.generator.histories).toEqual([[{ from: 'contact', text: turn }]]), WAIT);
  } finally {
    await h.stop();
  }
}, 30_000);

it('revokes consent on STOP even across officer pause, resume and the all-DM switch', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  const contact = 6000000712;
  try {
    await setReplies(h, true);
    await deliver(h, contact, 'Hello, I have a cabinet.');
    await vi.waitFor(async () => expect((await h.caseActionsOf(contact, 'ai_reply_sent'))
      .some(action => action.detail.source === 'consent_notice')).toBe(true), WAIT);
    await h.dispatch(contact);
    await deliver(h, contact, 'I AGREE');
    await deliver(h, contact, 'Would you like its dimensions?');
    await vi.waitFor(() => expect(stand.generator.histories).toHaveLength(1), WAIT);
    await h.control(contact, 'pause');
    await deliver(h, contact, 'STOP');
    await setReplies(h, false);
    await h.control(contact, 'resume');
    await setReplies(h, true);
    await deliver(h, contact, 'Hi, are you still interested?');
    await deliver(h, contact, 'The cabinet has three shelves.');
    expect(stand.generator.histories).toHaveLength(1);
  } finally {
    await h.stop();
  }
}, 30_000);
