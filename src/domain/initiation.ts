/**
 * Who started a conversation (design section 7, steps 8 and 9) and the origin label shown for it.
 * Pure functions: initiation is resolved only from a trusted start marker on the earliest stored message.
 */
import type { Direction, InitiatedBy, StartMarkerResult } from '../contract/enums.ts';
import { LABELS, type OriginLabel } from '../contract/labels.ts';

export interface StartMarkerInput {
  /** Whether the event carried `conversationStart`. */
  hasMarker: boolean;
  connectorTrusted: boolean;
  currentInitiatedBy: InitiatedBy;
  /** sentAt of the marked message, or null when the source gave none. */
  markedSentAt: string | null;
  /** sentAt of every other source message already stored for the chat. */
  otherSentAts: readonly (string | null)[];
}

export function decideStartMarker(input: StartMarkerInput): StartMarkerResult {
  if (!input.hasMarker) return 'none';
  if (!input.connectorTrusted) return 'ignored_untrusted';
  if (input.currentInitiatedBy !== 'unknown') return 'ignored_conflict';
  if (input.otherSentAts.length === 0) return 'accepted';
  const marked = input.markedSentAt === null ? Number.NaN : Date.parse(input.markedSentAt);
  if (Number.isNaN(marked)) return 'ignored_conflict';
  const allLater = input.otherSentAts.every((other) => other !== null && Date.parse(other) > marked);
  return allLater ? 'accepted' : 'ignored_conflict';
}

export function initiatorFor(direction: Direction): InitiatedBy {
  return direction === 'incoming' ? 'contact' : 'officer';
}

export function originLabel(initiatedBy: InitiatedBy, firstObservedDirection: Direction | null): OriginLabel {
  if (initiatedBy === 'contact') return LABELS.contactStartedChat;
  if (initiatedBy === 'officer') return LABELS.officerStartedChat;
  if (firstObservedDirection === 'incoming') return LABELS.firstObservedIncoming;
  if (firstObservedDirection === 'outgoing') return LABELS.firstObservedOutgoing;
  return LABELS.noMessagesObserved;
}
