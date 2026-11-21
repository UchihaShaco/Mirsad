/**
 * Whether a detail is new to the chat, a repeat or a change (design section 10, step 4). A detail is compared only
 * within its own category and only with the details earlier message events of the chat carried, which the caller
 * passes in a fixed order (the order they were first recorded). Links and recipients are compared with the current
 * details; any phone number seen before is a repeat.
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

/**
 * The details of the category seen last, which together are the chat's current destination: every detail at the
 * highest last-seen position, such as a holder name and an IBAN one message gave together. In the order given.
 */
function currentDetails(earlier: readonly KnownDetail[]): KnownDetail[] {
  const latest = earlier.reduce((highest, detail) => Math.max(highest, detail.lastSeenPosition), Number.NEGATIVE_INFINITY);
  return earlier.filter((detail) => detail.lastSeenPosition === latest);
}

/**
 * A repeat when the value is any of the current details; otherwise new, or a change from the first current detail in
 * the order given.
 */
export function decideDetail(category: DetailCategory, normalizedValue: string, earlier: readonly KnownDetail[]): DetailDecision {
  if (category === 'phone_number') {
    return earlier.some((detail) => detail.normalizedValue === normalizedValue) ? { kind: 'repeat' } : { kind: 'new' };
  }
  const current = currentDetails(earlier);
  if (current.some((detail) => detail.normalizedValue === normalizedValue)) return { kind: 'repeat' };
  const [first] = current;
  return first === undefined ? { kind: 'new' } : { kind: 'changed', changedFrom: first.displayValue };
}
