import { expect, it, vi } from 'vitest';
import { Harness, incoming, LIVE_BASE_ENV, standIns, WAIT } from '../helpers/telegram-live-harness.ts';

const listed = 6000000951;
const unlisted = 6000000952;
const env = { ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST',
  TELEGRAM_APPROVED_CHAT_IDS: String(listed) };
const prompts = '/v1/telegram/consent-prompt';

async function setPrompts(h: Harness, enabled: boolean): Promise<void> {
  expect((await h.call('POST', prompts, { enabled })).data.enabled).toBe(enabled);
}

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
