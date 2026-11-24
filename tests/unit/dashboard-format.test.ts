/**
 * The dashboard's notices for officer actions (src/dashboard/js/format.js): one sentence per answer, built only from the
 * per-chat statuses and counts the service returns and fixed text. Also: every case action the service records has a
 * label in the case log.
 */
import { describe, expect, it } from 'vitest';
import { CASE_ACTION_TYPES } from '../../src/contract/enums.ts';
import { AI_REPLY_FAILURE_NOTES, CASE_ACTION_LABELS, describeDispatch, evidenceItemsFor, silenceExplanation, silenceSummary, TELEGRAM_EVIDENCE_LABELS } from '../../src/dashboard/js/format.js';
import { MODEL_SILENCE_REASONS } from '../../src/replies/ali-decision.ts';

it('keeps pending evidence visible independently of the hold, including a legacy review', () => {
  const item = { actionId: 'review-1', messageId: 'message-1', messageEventId: 'event-1', reason: 'payment_link' as const };
  expect(evidenceItemsFor({ officerReview: null, evidenceItems: [item] })).toEqual([item]);
  const legacy = { actionId: 'old-review', messageId: 'old-message', reason: 'document' as const };
  expect(evidenceItemsFor({ officerReview: legacy })).toEqual([legacy]);
  expect(evidenceItemsFor({ officerReview: null })).toEqual([]);
});

it('labels a payment recipient’s bank details without exposing account values', () => {
  expect(TELEGRAM_EVIDENCE_LABELS.bank_details).toBe('bank transfer details');
});

describe('case log labels', () => {
  it('labels each model silence reason with fixed wording and separates guard and legacy decisions', () => {
    for (const reason of MODEL_SILENCE_REASONS) {
      const text = silenceSummary({ source: 'model', reason });
      expect(text).toMatch(/^The model /);
      expect(text).not.toMatch(/_/);
    }
    expect(silenceSummary({ source: 'model', reason: 'reason_unavailable' })).toBe('The model returned no reason for skipping this reply.');
    // A silence recorded before reasons were required says so, rather than suggesting a reason exists.
    expect(silenceSummary({ source: 'model', reason: 'other' })).toBe('The model gave no specific reason. This was recorded before a reason was required.');
    expect(silenceExplanation({ source: 'model', reason: 'already_answered', explanation: ' Ali already asked about the size. ' }))
      .toBe('Ali already asked about the size.');
    for (const detail of [null, { source: 'model', reason: 'already_answered' }, { source: 'reply_guard', explanation: 'Guard text.' },
      { source: 'model', explanation: 42 }, { source: 'model', explanation: 'x'.repeat(401) }]) {
      expect(silenceExplanation(detail)).toBeNull();
    }
    expect(silenceSummary({ source: 'reply_guard', reason: 'repeated_identity_question' })).toContain('Mirsad suppressed');
    expect(silenceSummary({ source: 'reply_guard', reason: 'repeated_meeting_question' })).toBe('Mirsad stopped a repeat question about meeting arrangements already discussed.');
    for (const detail of [null, { source: 'model', reason: 'private text' }, { source: 'model', reason: 'constructor' },
      { source: 'reply_guard', reason: 'already_answered' }]) {
      expect(silenceSummary(detail)).toBe('No reason was recorded.');
    }
  });

  it('has a label for every case action type, including the local-model replies', () => {
    expect(Object.keys(CASE_ACTION_LABELS).sort()).toEqual([...CASE_ACTION_TYPES].sort());
    expect(CASE_ACTION_LABELS.ai_reply_sent).toBe('Automated reply sent');
    expect(CASE_ACTION_LABELS.ai_reply_failed).toBe('AI reply failed');
  });

  it('explains the AI reply failures whose code alone would mislead: a guard block, and a reply sent but not stored', () => {
    expect(Object.keys(AI_REPLY_FAILURE_NOTES).sort()).toEqual(['blocked_reply', 'delivery_unknown', 'empty_reply', 'invalid_response',
      'selected_source_unavailable', 'source_unavailable', 'store_failed', 'telegram_chat_mismatch']);
    expect(AI_REPLY_FAILURE_NOTES.store_failed).toContain('Check Telegram');
  });
});

describe('dispatch notice', () => {
  it('says how many chats started, that an already active chat had any unavailable reviews queued again, and how many need Resume AI', () => {
    expect(describeDispatch([{ status: 'started' }, { status: 'started' }])).toBe('Dispatch: AI review started for 2 chats.');
    expect(describeDispatch([{ status: 'already_active' }])).toBe(
      'Dispatch: 1 chat was already active and any unavailable reviews were queued again.',
    );
    expect(describeDispatch([{ status: 'already_active' }, { status: 'already_active' }])).toBe(
      'Dispatch: 2 chats were already active and any unavailable reviews were queued again.',
    );
    expect(describeDispatch([{ status: 'started' }, { status: 'already_active' }, { status: 'requires_resume' }, { status: 'requires_resume' }])).toBe(
      'Dispatch: AI review started for 1 chat; 1 chat was already active and any unavailable reviews were queued again; 2 chats need Resume AI first.',
    );
  });
});
