/**
 * The dashboard's notices for officer actions (src/dashboard/js/format.js): one sentence per answer, built only from the
 * per-chat statuses and counts the service returns and fixed text.
 */
import { describe, expect, it } from 'vitest';
import { describeDispatch } from '../../src/dashboard/js/format.js';

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
