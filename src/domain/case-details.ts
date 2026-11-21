/**
 * Whether a detail is new to the chat, a repeat or a change (design section 10, step 4). A detail is compared only
 * within its own category and only with the details earlier message events of the chat carried, which the caller
 * passes in. Links and recipients are compared with the current detail; any phone number seen before is a repeat.
 */
import type { ExtractedKind } from '../contract/enums.ts';

export type DetailCategory = ExtractedKind;

export interface KnownDetail {
  normalizedValue: string;
  /** The value as first written. */
  displayValue: string;
  lastSeenPosition: number;
}

export type DetailDecision = { kind: 'new' } | { kind: 'repeat' } | { kind: 'changed'; changedFrom: string };

/** The detail of the category seen last: the chat's current destination. */
function currentDetail(earlier: readonly KnownDetail[]): KnownDetail | null {
  return earlier.reduce<KnownDetail | null>(
    (latest, detail) => (latest === null || detail.lastSeenPosition > latest.lastSeenPosition ? detail : latest),
    null,
  );
}

export function decideDetail(category: DetailCategory, normalizedValue: string, earlier: readonly KnownDetail[]): DetailDecision {
  if (category === 'phone_number') {
    return earlier.some((detail) => detail.normalizedValue === normalizedValue) ? { kind: 'repeat' } : { kind: 'new' };
  }
  const current = currentDetail(earlier);
  if (current === null) return { kind: 'new' };
  return current.normalizedValue === normalizedValue ? { kind: 'repeat' } : { kind: 'changed', changedFrom: current.displayValue };
}
