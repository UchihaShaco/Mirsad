/**
 * The chat timeline (design section 6): messages with capture and review state, later message events, the case log,
 * findings and case references, plus the snapshot cursor read in the same transaction. Findings and case references
 * are read straight from their tables so the tasks that insert them need no change here.
 */
import type { CaptureMethod, Concern } from '../contract/enums.ts';
import { LABELS, type FindingLabel } from '../contract/labels.ts';
import type { Finding, Message, MessageEvent, Timeline } from '../contract/schemas.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { listCaseActionsForChat } from '../storage/repos/case-actions.ts';
import { listCapturesForChat, type CaptureWithArtifact } from '../storage/repos/captures.ts';
import { listMessageEvents, listMessages } from '../storage/repos/messages.ts';
import { listReviewsForChat } from '../storage/repos/reviews.ts';
import type { CaseReferenceRow, ChatRow, FindingRow, MessageEventRow, MessageRow, ReviewRow } from '../storage/rows.ts';
import { requireChat } from './access.ts';
import { currentCursor, summaryOf } from './chats.ts';
import {
  principalLookup,
  toCapture,
  toCaseAction,
  toCaseReference,
  toMessage,
  toReview,
  type MessageEvidence,
  type PrincipalLookup,
} from './mappers.ts';

interface EventIndex {
  recordedByMessage: Map<string, MessageEventRow>;
  captures: Map<string, CaptureWithArtifact>;
  reviews: Map<string, ReviewRow>;
}

function evidenceOf(row: MessageRow, index: EventIndex): MessageEvidence {
  const recordedEvent = index.recordedByMessage.get(row.id);
  if (!recordedEvent) return {};
  return { recordedEvent, capture: index.captures.get(recordedEvent.id), review: index.reviews.get(recordedEvent.id) };
}

function toMessageEvent(row: MessageEventRow, index: EventIndex): MessageEvent {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    type: row.type as MessageEvent['type'],
    text: row.text,
    sourceEventId: row.source_event_id ?? '',
    sourceOccurredAt: row.source_occurred_at,
    receivedAt: row.received_at,
    captureMethod: row.capture_method as CaptureMethod,
    capture: toCapture(index.captures.get(row.id)),
    review: toReview(index.reviews.get(row.id)),
    position: row.position,
  };
}

/** Fixed label templates (design section 10): never model text. */
export function findingLabel(kind: FindingRow['kind'], changedFrom: string | null): FindingLabel {
  switch (kind) {
    case 'suspected_fraud':
      return LABELS.suspectedFraud;
    case 'phone_number':
      return LABELS.phoneNumberTiedToConcern;
    case 'payment_link':
      return changedFrom === null ? LABELS.newPaymentLink : LABELS.paymentDestinationChanged;
    case 'payment_recipient':
      return changedFrom === null ? LABELS.newPaymentRecipient : LABELS.paymentDestinationChanged;
  }
}

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    messageEventId: row.message_event_id,
    kind: row.kind,
    label: findingLabel(row.kind, row.changed_from),
    quote: row.quote,
    extractedValue: row.extracted_value,
    concern: row.concern as Concern | null,
    changedFrom: row.changed_from,
    caseReferenceId: row.case_reference_id,
    note: row.note,
    createdAt: row.created_at,
    position: row.position,
  };
}

function buildIndex(tx: Tx, chatId: string, events: readonly MessageEventRow[]): EventIndex {
  const recordedByMessage = new Map(events.filter((e) => e.type === 'recorded').map((e) => [e.message_id, e] as const));
  const captures = new Map(listCapturesForChat(tx, chatId).map((c) => [c.message_event_id, c] as const));
  const reviews = new Map(listReviewsForChat(tx, chatId).map((r) => [r.message_event_id, r] as const));
  return { recordedByMessage, captures, reviews };
}

function readEvidence(tx: Tx, chat: ChatRow, source: Message['source']['channel'], lookup: PrincipalLookup) {
  const events = listMessageEvents(tx, chat.id);
  const index = buildIndex(tx, chat.id, events);
  return {
    messages: listMessages(tx, chat.id).map((m) => toMessage(m, source, evidenceOf(m, index), lookup)),
    messageEvents: events.filter((e) => e.type !== 'recorded').map((e) => toMessageEvent(e, index)),
  };
}

export function readTimeline(tx: Tx, principal: Principal, chatId: string): Timeline {
  const chat = requireChat(tx, principal, chatId);
  const cursor = currentCursor(tx, chat.workspace_id);
  const summary = summaryOf(tx, principal, chat);
  const lookup = principalLookup(tx);
  const { messages, messageEvents } = readEvidence(tx, chat, summary.source, lookup);
  const params = { chatId: chat.id };
  return {
    chat: summary,
    messages,
    messageEvents,
    caseActions: listCaseActionsForChat(tx, chat.id).map((a) => toCaseAction(a, lookup)),
    findings: tx.all<FindingRow>('SELECT * FROM findings WHERE chat_id = :chatId ORDER BY position, id', params).map(toFinding),
    caseReferences: tx
      .all<CaseReferenceRow>('SELECT * FROM case_references WHERE chat_id = :chatId ORDER BY position, id', params)
      .map((r) => toCaseReference(r, lookup)),
    cursor,
  };
}
