import { expect, it, vi } from 'vitest';
import type { ReplyGenerator } from '../../src/replies/reply-generator.ts';
import { parseAliDecision } from '../../src/replies/ali-decision.ts';
import { Harness, incoming, LIVE_BASE_ENV, OWNER_ID, standIns, WAIT } from '../helpers/telegram-live-harness.ts';

it.each(['MONITORING', 'SUSPICIOUS'])('attributes a repeated meeting question to the guard and respects %s', async status => {
  const stand = standIns();
  const generator: ReplyGenerator = stand.generator;
  generator.decide = async () => parseAliDecision(JSON.stringify({ case_status: status, should_reply: true,
    external_reply: 'Where should we meet?', review_reasons: [], silence_reason: null }));
  const contact = 6000000875;
  const h = await Harness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true' }, stand);
  try {
    const now = stand.clock.now().getTime();
    await h.deliver(incoming(contact, 'Can we meet at the test station on Saturday at 5pm?', now, { fromId: OWNER_ID }),
      incoming(contact, 'Yes, that works.', now));
    stand.clock.advance(3_000);
    await vi.waitFor(async () => {
      const actions = await h.caseActionsOf(contact, 'ai_reply_skipped');
      expect(actions[0]?.detail).toMatchObject({ source: 'reply_guard', reason: 'repeated_meeting_question' });
    }, WAIT);
    expect((await h.caseActionsOf(contact, 'lower_concern_assessed')).length).toBe(status === 'MONITORING' ? 1 : 0);
    expect(stand.sender.sent).toHaveLength(0);
  } finally {
    await h.stop();
  }
});
