/**
 * The one mapping from stored message and case-action rows to their API shapes (design section 6). The timeline and
 * the officer actions both use it, so a composer or decision response is exactly the entry the timeline shows.
 */
import type { CaptureMethod, CaseActionType, Source } from '../contract/enums.ts';
import { LABELS } from '../contract/labels.ts';
import type { Capture, CaseAction, Message, PrincipalRef, ReviewState } from '../contract/schemas.ts';
import type { Tx } from '../storage/db.ts';
import type { CaptureWithArtifact } from '../storage/repos/captures.ts';
import type { CaseActionRow, MessageEventRow, MessageRow, ReviewRow } from '../storage/rows.ts';

export type PrincipalLookup = (id: string | null) => PrincipalRef | null;

/** Resolves principal IDs to references within one transaction, reading each principal once. */
export function principalLookup(tx: Tx): PrincipalLookup {
  const cache = new Map<string, PrincipalRef | null>();
  return (id) => {
    if (id === null) return null;
    if (!cache.has(id)) {
      const row = tx.get<{ id: string; display_name: string }>('SELECT id, display_name FROM principals WHERE id = :id', { id });
      cache.set(id, row ? { id: row.id, displayName: row.display_name } : null);
    }
    return cache.get(id) ?? null;
  };
}

export function toCapture(row: CaptureWithArtifact | undefined): Capture | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    kind: 'mirsad_rendered_capture',
    artifactId: row.artifact_id,
    sha256: row.artifact_sha256,
    attempts: row.attempts,
    errorCode: row.last_error_code,
    retryable: row.status === 'failed',
    updatedAt: row.updated_at,
  };
}

export function toReview(row: ReviewRow | undefined): ReviewState | null {
  return row ? { status: row.status, outcome: row.outcome, updatedAt: row.updated_at } : null;
}

/** What is stored beside a message row: its `recorded` event, and that event's capture and review. */
export interface MessageEvidence {
  recordedEvent?: MessageEventRow;
  capture?: CaptureWithArtifact;
  review?: ReviewRow;
}

/** A composer message is Mirsad's own record: it has an author but no sender, capture or review. */
export function toMessage(row: MessageRow, channel: Source, evidence: MessageEvidence, lookup: PrincipalLookup): Message {
  const { recordedEvent } = evidence;
  const isComposer = row.origin === 'officer_composer';
  const reviewApplies = !isComposer && row.direction === 'incoming';
  return {
    id: row.id,
    chatId: row.chat_id,
    direction: row.direction,
    origin: row.origin,
    text: row.text,
    originalCaptured: row.original_captured === 1,
    unsupportedContent: JSON.parse(row.unsupported_content) as string[],
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    source: {
      channel,
      captureMethod: row.capture_method as CaptureMethod,
      sourceEventId: recordedEvent?.source_event_id ?? null,
      sourceMessageId: row.source_message_id,
    },
    sender: isComposer ? null : { externalId: row.sender_external_id, displayName: row.sender_display_name },
    author: lookup(row.author_officer_id),
    sendStatus: row.send_status,
    sendStatusLabel: row.send_status === 'simulated' ? LABELS.simulatedSend : null,
    capture: isComposer || !recordedEvent ? null : toCapture(evidence.capture),
    review: reviewApplies && recordedEvent ? toReview(evidence.review) : null,
    editedAtSource: row.edited_at_source === 1,
    deletedAtSource: row.deleted_at_source === 1,
    position: row.position,
  };
}

export function toCaseAction(row: CaseActionRow, lookup: PrincipalLookup): CaseAction {
  return {
    id: row.id,
    chatId: row.chat_id,
    type: row.type as CaseActionType,
    actor: lookup(row.actor_id),
    messageId: row.message_id,
    fromMode: row.from_mode,
    toMode: row.to_mode,
    revision: row.revision,
    detail: row.detail === null ? null : (JSON.parse(row.detail) as CaseAction['detail']),
    occurredAt: row.occurred_at,
    position: row.position,
  };
}
