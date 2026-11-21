// Stub until Task 6 adds the rules: returns no items. The signature is final.
import type { Reviewer } from '../ports/reviewer.ts';

export function createDeterministicReviewer(): Reviewer {
  return {
    name: 'deterministic',
    async review() {
      return { items: [] };
    },
  };
}
