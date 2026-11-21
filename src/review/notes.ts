/**
 * Officer-facing notes (design section 10, step 6): one short sentence per finding label, built only from fixed text and
 * the message direction. Model text, the quote and the extracted value never go into a note.
 */
import type { Direction } from '../contract/enums.ts';
import { LABELS, type FindingLabel } from '../contract/labels.ts';

const WHERE: Record<Direction | 'unknown', string> = {
  incoming: 'in a message from the contact',
  outgoing: 'in an outgoing message',
  unknown: 'in a message',
};

export function findingNote(label: FindingLabel, direction: Direction | null): string {
  const where = WHERE[direction ?? 'unknown'];
  if (label === LABELS.suspectedFraud) return `${label}: a payment link host differs from the merchant confirmation, ${where}.`;
  return `${label} ${where}.`;
}
