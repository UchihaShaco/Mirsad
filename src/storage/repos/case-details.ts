/** Case details: the payment links, recipients and phone numbers each chat has already surfaced (design section 10). */
import type { ExtractedKind } from '../../contract/enums.ts';
import type { Tx } from '../db.ts';
import { newId } from '../ids.ts';

export interface CaseDetailRow {
  id: string;
  chat_id: string;
  category: ExtractedKind;
  normalized_value: string;
  display_value: string;
  first_message_id: string;
  last_seen_position: number;
  created_at: string;
}

/**
 * The chat's details by last sighting; details seen last together stay in the order they were first recorded. That is
 * rowid order, because details are never deleted and an upsert keeps the row (the random id would order them by chance).
 */
export function listCaseDetails(tx: Tx, chatId: string): CaseDetailRow[] {
  return tx.all<CaseDetailRow>('SELECT * FROM case_details WHERE chat_id = :chatId ORDER BY last_seen_position, rowid', { chatId });
}

export interface RecordCaseDetailInput {
  chatId: string;
  category: ExtractedKind;
  normalizedValue: string;
  /** The value as written; kept only the first time the detail is seen. */
  displayValue: string;
  messageId: string;
  /** Position of the message event that carried the detail. */
  position: number;
}

/** Records that a message event carried the detail: inserted the first time, last seen moved forward after that. */
export function recordCaseDetail(tx: Tx, input: RecordCaseDetailInput): void {
  tx.run(
    `INSERT INTO case_details (id, chat_id, category, normalized_value, display_value, first_message_id, last_seen_position, created_at)
     VALUES (:id, :chatId, :category, :normalizedValue, :displayValue, :messageId, :position, :at)
     ON CONFLICT (chat_id, category, normalized_value)
     DO UPDATE SET last_seen_position = MAX(last_seen_position, excluded.last_seen_position)`,
    { ...input, id: newId('det'), at: tx.now() },
  );
}
