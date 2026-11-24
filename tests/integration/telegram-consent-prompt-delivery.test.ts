import { expect, it, vi } from 'vitest';
import { Harness, incoming, LIVE_BASE_ENV, standIns, WAIT } from '../helpers/telegram-live-harness.ts';

const listed = 6000000951;
const unlisted = 6000000952;
const env = { ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST',
  TELEGRAM_APPROVED_CHAT_IDS: String(listed) };
const prompts = '/v1/telegram/consent-prompt';

it('keeps a test-approved chat replying in manual-only mode and waits for dispatch on other chats', async () => {
  const next = unlisted + 1;
  const stand = standIns();
  let h = await Harness.start(env, stand);
  try {
    await h.call('POST', '/v1/telegram/dm-replies', { enabled: true });
    await setPrompts(h, false);
    await h.receive(unlisted, 'First question from our test account.');
    const selected = (await h.chatFor(unlisted))!;
    const grant = { participantPermissionRecorded: true };
    expect((await h.call('POST', '/v1/dispatches', { chatIds: [selected.id], ...grant, expectedTestMode: true },
      { 'Idempotency-Key': 'test-approved-before-switch' })).success).toBe(true);
    await h.app.drain();
    expect(stand.sender.to(unlisted)).toHaveLength(1);
    expect((await h.call('POST', prompts, { enabled: false, manualDispatchOnly: true })).error.code).toBe('validation_failed');
    const manual = { enabled: true, manualDispatchOnly: true };
    expect((await h.call('POST', prompts, manual)).data).toEqual({ ...manual, available: true });
    await h.close();
    h = await Harness.start(env, stand, h.data);
    expect((await h.call('GET', prompts)).data).toEqual({ ...manual, available: true });
    await h.receive(unlisted, 'My approved chat continues.');
    await h.receive(next, 'A new participant has a question.');
    await h.receive(next, 'Can you answer my more recent question?');
    await h.app.drain();
    expect(stand.sender.to(unlisted)).toHaveLength(2);
    expect(stand.sender.to(next)).toHaveLength(0);
    const waiting = (await h.chatFor(next))!;
    expect(waiting.aiMode).toBe('not_started');
    expect(stand.generator.histories).toHaveLength(2);
    expect((await h.call('POST', '/v1/dispatches', { chatIds: [waiting.id], ...grant },
      { 'Idempotency-Key': 'manual-grant-after-switch' })).success).toBe(true);
    await h.app.drain();
    expect(stand.generator.histories[2]).toEqual([{ from: 'contact', text: 'Can you answer my more recent question?' }]);
    expect(stand.sender.to(next)).toHaveLength(1);
    await setPrompts(h, false);
    await h.receive(next + 1, 'A new test chat.');
    expect((await h.chatFor(next + 1))?.aiMode).toBe('ai_active');
  } finally { await h.stop(); }
});

it('cancels pending invitations in manual-only mode and resumes legacy invitations only on fresh messages', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    await h.call('POST', '/v1/telegram/dm-replies', { enabled: true });
    await h.deliver(incoming(unlisted, 'Received before manual mode.', stand.clock.now().getTime()));
    const switchMode = await h.call('POST', prompts, { enabled: true, manualDispatchOnly: true });
    expect(switchMode.success).toBe(true);
    stand.clock.advance(3_000);
    await h.app.drain();
    expect(stand.sender.to(unlisted)).toHaveLength(0);
    await setPrompts(h, true);
    await h.app.drain();
    expect(stand.sender.to(unlisted)).toHaveLength(0);
    await h.receive(unlisted, 'A fresh request after enabling invitations.');
    await h.app.drain();
    expect((await h.caseActionsOf(unlisted, 'ai_reply_sent'))[0]?.detail.source).toBe('consent_notice');
    expect(stand.generator.histories).toHaveLength(0);
  } finally { await h.stop(); }
});

async function setPrompts(h: Harness, enabled: boolean): Promise<void> {
  expect((await h.call('POST', prompts, { enabled })).data.enabled).toBe(enabled);
}

it('requires manual dispatch for an unapproved active chat even when it received an earlier invitation', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    await h.call('POST', '/v1/telegram/dm-replies', { enabled: true });
    await h.receive(unlisted, 'Please tell me about this item.');
    await h.app.drain();
    expect(stand.sender.to(unlisted)).toHaveLength(1);
    await setPrompts(h, false);
    await h.receive(unlisted, 'Checking again in Test mode.');
    expect((await h.chatFor(unlisted))?.aiMode).toBe('ai_active');
    await h.call('POST', prompts, { enabled: true, manualDispatchOnly: true });
    await h.receive(unlisted, 'I AGREE');
    await h.receive(unlisted, 'Is the item available?');
    await h.app.drain();
    expect(stand.generator.histories).toHaveLength(0);
    expect(stand.sender.to(unlisted)).toHaveLength(1);
    await h.receive(unlisted, 'STOP');
    expect((await h.chatFor(unlisted))?.telegramReplyHold.contactOptedOut).toBe(true);
  } finally { await h.stop(); }
});

it('silences waiting invitations and only offers consent on fresh messages after a restart and re-enable', async () => {
  const first = standIns();
  let h = await Harness.start(env, first);
  try {
    expect((await h.call('POST', '/v1/telegram/dm-replies', { enabled: true })).data.enabled).toBe(true);
    await h.deliver(incoming(unlisted, 'Hi there.', first.clock.now().getTime()));
    // This DM is stored and is still inside the reply quiet period.
    await setPrompts(h, false);
    first.clock.advance(3_000);
    await h.app.drain();
    await h.receive(unlisted, 'I AGREE');
    await h.app.drain();
    expect(first.sender.sent).toHaveLength(0);
    expect(first.generator.histories).toHaveLength(0);
    await h.close();

    const again = standIns(first.clock);
    h = await Harness.start(env, again, h.data);
    const beforeEnable = again.clock.now().getTime();
    await h.receive(unlisted, 'Stored while invitations were off');
    await setPrompts(h, true);
    await h.receive(unlisted, 'Arrived late from before the switch', beforeEnable);
    await h.app.drain();
    expect(again.sender.sent).toHaveLength(0);
    expect(again.generator.histories).toHaveLength(0);
    await h.receive(unlisted, 'Fresh incoming message');
    await h.app.drain();
    expect(again.sender.to(unlisted)).toHaveLength(1);
    expect((await h.caseActionsOf(unlisted, 'ai_reply_sent'))[0]?.detail.source).toBe('consent_notice');
    expect(again.generator.histories).toHaveLength(0);
  } finally { await h.stop(); }
});

it('continues pre-approved replies and honors a previously delivered invitation while new invitations are off', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    expect((await h.call('POST', '/v1/telegram/dm-replies', { enabled: true })).data.enabled).toBe(true);
    await h.receive(unlisted, 'Hi from a new contact');
    await h.app.drain();
    expect(stand.sender.to(unlisted)).toHaveLength(1);
    await setPrompts(h, false);
    await h.receive(unlisted, 'أوافق');
    await h.app.drain();
    const followUp = 'Would you like the dimensions?';
    await h.receive(unlisted, followUp);
    await h.app.drain();
    expect(stand.generator.histories).toEqual([[{ from: 'contact', text: followUp }]]);
    const listedTurn = 'Is the cabinet the right size?';
    stand.generator.holdNext();
    await h.receive(listed, listedTurn);
    await vi.waitFor(() => expect(stand.generator.histories.at(-1)).toEqual([{ from: 'contact', text: listedTurn }]), WAIT);
    await setPrompts(h, true);
    await setPrompts(h, false);
    stand.generator.releaseHeld();
    await h.app.drain();
    expect(stand.sender.to(listed)).toHaveLength(1);
  } finally { stand.generator.releaseHeld(); await h.stop(); }
});
