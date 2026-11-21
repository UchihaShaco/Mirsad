/** Case references: officer-recorded facts such as a merchant's payment confirmation (design section 10). */
import { z } from 'zod';
import { appendStreamEvent } from '../../services/stream.ts';
import type { Tx } from '../db.ts';
import { newId } from '../ids.ts';
import type { CaseReferenceRow } from '../rows.ts';

const PaymentHosts = z.array(z.string());

export interface InsertCaseReferenceInput {
  chatId: string;
  /** The chat's workspace, for the stream event. */
  workspaceId: string;
  paymentHosts: string[];
  sourceNote: string;
  recordedBy: string;
}

/** Stores a merchant payment confirmation and publishes `case_reference.recorded`, whose sequence is its position. */
export function insertCaseReference(tx: Tx, input: InsertCaseReferenceInput): CaseReferenceRow {
  const id = newId('cref');
  const position = appendStreamEvent(tx, {
    workspaceId: input.workspaceId,
    type: 'case_reference.recorded',
    chatId: input.chatId,
    data: { caseReferenceId: id },
  });
  const row = tx.get<CaseReferenceRow>(
    `INSERT INTO case_references (id, chat_id, kind, payment_hosts, source_note, recorded_by, recorded_at, position)
     VALUES (:id, :chatId, 'merchant_payment_confirmation', :paymentHosts, :sourceNote, :recordedBy, :at, :position)
     RETURNING *`,
    {
      id,
      chatId: input.chatId,
      paymentHosts: JSON.stringify(input.paymentHosts),
      sourceNote: input.sourceNote,
      recordedBy: input.recordedBy,
      at: tx.now(),
      position,
    },
  );
  if (!row) throw new Error('case_reference_insert_failed');
  return row;
}

/** The chat's case references, oldest first. */
export function listCaseReferences(tx: Tx, chatId: string): CaseReferenceRow[] {
  return tx.all<CaseReferenceRow>('SELECT * FROM case_references WHERE chat_id = :chatId ORDER BY position, id', { chatId });
}

export function paymentHostsOf(row: CaseReferenceRow): string[] {
  return PaymentHosts.parse(JSON.parse(row.payment_hosts));
}
