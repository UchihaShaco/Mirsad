/**
 * Ali never stays silent without saying why: the model must choose a specific reason, and the officer sees its own
 * one-sentence explanation beside it. Synthetic chat IDs and texts only; nothing here talks to Telegram or a model.
 */
import { expect, it, vi } from 'vitest';
import { SILENCE_EXPLANATION_REQUEST } from '../../src/replies/ali-decision.ts';
import type { ReplyGenerator } from '../../src/replies/reply-generator.ts';
import { Harness, LIVE_BASE_ENV, standIns } from '../helpers/telegram-live-harness.ts';

const contact = 6000000887;
const env = { ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true' };

it('asks the model once more for a silence it did not explain and records the explanation for the officer', async () => {
  const stand = standIns();
  const explanation = 'The sender only thanked Ali and asked nothing new.';
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>()
    .mockResolvedValueOnce({ kind: 'silence', reason: 'no_actionable_question' })
    .mockResolvedValueOnce({ kind: 'silence', reason: 'no_actionable_question', explanation });
  Object.assign(stand.generator, { decide });
  const h = await Harness.start(env, stand);
  try {
    const message = await h.receive(contact, 'Thanks, that is all for now.');
    await h.app.drain();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls[0]?.[2]).toBeUndefined();
    expect(decide.mock.calls[1]?.[2]).toBe(SILENCE_EXPLANATION_REQUEST);
    const skipped = await h.caseActionsOf(contact, 'ai_reply_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ messageId: message.id, detail: { source: 'model', reason: 'no_actionable_question', explanation } });
    expect(stand.sender.to(contact)).toHaveLength(0);
    // Logs keep codes only.
    expect(h.logs.join('\n')).not.toContain(explanation);
  } finally { await h.stop(); }
});

it('keeps the specific reason when the model still gives no explanation, and asks only once more', async () => {
  const stand = standIns();
  const decide = vi.fn<NonNullable<ReplyGenerator['decide']>>().mockResolvedValue({ kind: 'silence', reason: 'conversation_closed' });
  Object.assign(stand.generator, { decide });
  const h = await Harness.start(env, stand);
  try {
    await h.receive(contact, 'Okay, goodbye.');
    await h.app.drain();
    expect(decide).toHaveBeenCalledTimes(2);
    const skipped = await h.caseActionsOf(contact, 'ai_reply_skipped');
    expect(skipped.map(action => action.detail)).toEqual([{ source: 'model', reason: 'conversation_closed', model: 'test-model' }]);
    expect(stand.sender.to(contact)).toHaveLength(0);
  } finally { await h.stop(); }
});
