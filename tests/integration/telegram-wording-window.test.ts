import { expect, it, vi } from 'vitest';
import { FakeClock } from '../helpers/fake-clock.ts';
import { Harness, LIVE_BASE_ENV, standIns, WAIT } from '../helpers/telegram-live-harness.ts';

const contact = 6000000791;
const longReply = 'Thanks for mentioning this to me. '.repeat(10).trim();

async function start(scope: Record<string, string> = {}) {
  const clock = new FakeClock(new Date().toISOString());
  const stand = standIns(clock);
  const deadline = new Date(clock.now().getTime() + 60_000).toISOString();
  const h = await Harness.start({
    ...LIVE_BASE_ENV,
    TELEGRAM_AI_AUTO_START: 'true',
    TELEGRAM_APPROVED_CHAT_IDS: String(contact),
    MIRSAD_TEST_WORDING_UNTIL: deadline,
    ...scope,
  }, stand);
  return { h, stand, clock, deadline };
}

it('allows a lengthy draft during the single-chat window and restores the full check when inference crosses its deadline', async () => {
  const { h, stand, clock, deadline } = await start();
  try {
    stand.generator.replyNext(longReply);
    await h.receive(contact, 'Good morning.');
    await vi.waitFor(() => expect(stand.sender.to(contact)).toHaveLength(1), WAIT);
    expect(stand.sender.to(contact)[0]!.reply.text).toBe(longReply);
    expect(stand.generator.corrections).toEqual([undefined]);

    stand.generator.holdNext();
    stand.generator.replyNext(longReply, 'Thanks.');
    await h.receive(contact, 'The weather is pleasant today.');
    await vi.waitFor(() => expect(stand.generator.histories).toHaveLength(2), WAIT);
    clock.set(deadline);
    stand.generator.releaseHeld();
    await vi.waitFor(() => expect(stand.sender.to(contact)).toHaveLength(2), WAIT);
    expect(stand.sender.to(contact)[1]!.reply.text).toBe('Thanks.');
    expect(stand.generator.corrections).toEqual([undefined, undefined, 'too_verbose']);
  } finally {
    stand.generator.releaseHeld();
    await h.stop();
  }
});

it.each([
  { TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST-ALL-CHATS' },
  { TELEGRAM_APPROVED_CHAT_IDS: `${contact},6000000792` },
] as Record<string, string>[])('keeps wording checks for a broader chat scope (%#)', async scope => {
  const { h, stand } = await start(scope);
  try {
    stand.generator.replyNext(longReply, 'Good morning.');
    await h.receive(contact, 'Good morning.');
    await vi.waitFor(() => expect(stand.sender.to(contact)).toHaveLength(1), WAIT);
    expect(stand.sender.to(contact)[0]!.reply.text).toBe('Good morning.');
    expect(stand.generator.corrections).toEqual([undefined, 'too_verbose']);
  } finally {
    await h.stop();
  }
});
