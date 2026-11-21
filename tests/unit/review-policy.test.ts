import { describe, expect, it } from 'vitest';
import { CAPTURE_METHODS, SOURCES } from '../../src/contract/enums.ts';
import { isReviewPermitted } from '../../src/domain/review-policy.ts';

describe('review policy', () => {
  it('isReviewPermitted never allows telegram_business_live', () => {
    for (const source of SOURCES) {
      expect(isReviewPermitted(source, 'telegram_business_live', ['telegram_business_live', 'fixture_replay'])).toBe(
        false,
      );
    }
  });

  it('isReviewPermitted allows Telegram content only from fixture_replay even when another method is allow-listed', () => {
    const everything = [...CAPTURE_METHODS];
    expect(isReviewPermitted('telegram', 'fixture_replay', ['fixture_replay'])).toBe(true);
    for (const method of CAPTURE_METHODS.filter((m) => m !== 'fixture_replay')) {
      expect(isReviewPermitted('telegram', method, everything), method).toBe(false);
    }
  });

  it('isReviewPermitted allows other sources only for allow-listed methods', () => {
    expect(isReviewPermitted('whatsapp', 'fixture_replay', ['fixture_replay'])).toBe(true);
    expect(isReviewPermitted('whatsapp', 'approved_import', ['fixture_replay'])).toBe(false);
    expect(isReviewPermitted('whatsapp', 'approved_import', ['fixture_replay', 'approved_import'])).toBe(true);
    expect(isReviewPermitted('whatsapp', 'host_intake', ['approved_import'])).toBe(false);
    expect(isReviewPermitted('whatsapp', 'fixture_replay', [])).toBe(false);
  });

  it('isReviewPermitted refuses Telegram fixture content when fixture_replay is not allow-listed', () => {
    expect(isReviewPermitted('telegram', 'fixture_replay', [])).toBe(false);
    expect(isReviewPermitted('telegram', 'fixture_replay', ['approved_import', 'host_intake'])).toBe(false);
  });
});
