/** Findings: what review publishing and case references surface to the officer (design sections 4 and 10). */
import type { Concern, FindingKind } from '../../contract/enums.ts';
import { appendStreamEvent } from '../../services/stream.ts';
import type { Tx } from '../db.ts';
import { newId } from '../ids.ts';
import type { FindingRow, MessageEventRow, MessageRow } from '../rows.ts';

export interface InsertFindingInput {
  chatId: string;
  workspaceId: string;
  /** null for a rule finding raised by a case reference. */
  reviewId: string | null;
  messageId: string;
  messageEventId: string;
  kind: FindingKind;
  quote: string;
  extractedValue: string;
  normalizedValue: string;
  concern: Concern | null;
  changedFrom: string | null;
  caseReferenceId: string | null;
  note: string;
}

function findingExists(tx: Tx, input: Pick<InsertFindingInput, 'messageEventId' | 'kind' | 'normalizedValue'>): boolean {
  const row = tx.get<{ id: string }>(
    'SELECT id FROM findings WHERE message_event_id = :messageEventId AND kind = :kind AND normalized_value = :normalizedValue',
    { messageEventId: input.messageEventId, kind: input.kind, normalizedValue: input.normalizedValue },
  );
  return row !== undefined;
}

/**
 * Inserts the finding and publishes `finding.created`, whose sequence becomes its position. Returns null, writing
 * nothing, when the message event already has this finding.
 */
export function insertFinding(tx: Tx, input: InsertFindingInput): FindingRow | null {
  if (findingExists(tx, input)) return null;
  const id = newId('fnd');
  const position = appendStreamEvent(tx, {
    workspaceId: input.workspaceId,
    type: 'finding.created',
    chatId: input.chatId,
    data: { messageId: input.messageId, findingId: id, kind: input.kind },
  });
  const row = tx.get<FindingRow>(
    `INSERT INTO findings (id, chat_id, workspace_id, review_id, message_id, message_event_id, kind, quote, extracted_value,
       normalized_value, concern, changed_from, case_reference_id, note, created_at, position)
     VALUES (:id, :chatId, :workspaceId, :reviewId, :messageId, :messageEventId, :kind, :quote, :extractedValue,
       :normalizedValue, :concern, :changedFrom, :caseReferenceId, :note, :at, :position)
     RETURNING *`,
    { ...input, id, at: tx.now(), position },
  );
  if (!row) throw new Error('finding_insert_failed');
  return row;
}

export function listFindingsOfKind(tx: Tx, chatId: string, kind: FindingKind): FindingRow[] {
  return tx.all<FindingRow>('SELECT * FROM findings WHERE chat_id = :chatId AND kind = :kind ORDER BY position, id', { chatId, kind });
}

/**
 * For each payment link a payment link or Suspected fraud finding of the chat cites (by normalized value), the position
 * of the earliest message event that such a finding cites for it.
 */
export function firstLinkFindingPositions(tx: Tx, chatId: string): Map<string, number> {
  const rows = tx.all<{ normalized_value: string; position: number }>(
    `SELECT f.normalized_value, MIN(e.position) AS position
     FROM findings f JOIN message_events e ON e.id = f.message_event_id
     WHERE f.chat_id = :chatId AND f.kind IN ('payment_link', 'suspected_fraud')
     GROUP BY f.normalized_value`,
    { chatId },
  );
  return new Map(rows.map((row) => [row.normalized_value, row.position]));
}

/** The message and message event a finding cites. */
export function findCitedEvidence(
  tx: Tx,
  finding: Pick<FindingRow, 'message_id' | 'message_event_id'>,
): { message: MessageRow; messageEvent: MessageEventRow } {
  const message = tx.get<MessageRow>('SELECT * FROM messages WHERE id = :id', { id: finding.message_id });
  const messageEvent = tx.get<MessageEventRow>('SELECT * FROM message_events WHERE id = :id', { id: finding.message_event_id });
  if (!message || !messageEvent) throw new Error('finding_evidence_missing');
  return { message, messageEvent };
}
