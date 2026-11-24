import { contactOfferEvents, type ReplyOfferMemory } from '../replies/reply-generator.ts';
import type { Tx } from '../storage/db.ts';
import { directTelegramTextSql } from '../storage/repos/messages.ts';
import { verifiedTelegramSourceSql, type TelegramSourceProof } from '../adapters/telegram/message-proof.ts';
import { permittedDispatchSourceSql } from '../services/telegram-dispatch-permission.ts';

/** The same enrollment, source, deletion and evidence boundaries apply to recent turns and remembered offers. */
export const eligibleReplySources = `m.chat_id = :chatId AND m.position >= :firstPosition
  AND m.origin = 'source' AND m.original_captured = 1 AND m.deleted_at_source = 0
  AND m.capture_method='telegram_business_live' AND ${directTelegramTextSql}
  AND NOT EXISTS (SELECT 1 FROM telegram_evidence_sources x WHERE x.message_id=m.id AND x.reason='bank_details')
  AND unixepoch(COALESCE(m.sent_at,m.received_at)) >= :enrolledSecond
  AND (m.direction IS NOT 'outgoing' OR NOT EXISTS (
    SELECT 1 FROM case_actions sent LEFT JOIN messages trigger ON trigger.id=json_extract(sent.detail,'$.inReplyTo')
    WHERE sent.message_id=m.id AND sent.type='ai_reply_sent'
      AND (json_extract(sent.detail,'$.source')='consent_notice' OR trigger.position < :firstPosition)))
  AND (:afterTelegramId IS NULL OR (m.source_message_id GLOB 'tg:[0-9]*' AND CAST(substr(m.source_message_id,4) AS INTEGER)>:afterTelegramId))`;

export const latestEditText = `(SELECT e.text FROM message_events e
  WHERE e.message_id = m.id AND e.type = 'edited' AND e.text IS NOT NULL
  ORDER BY e.position DESC LIMIT 1)`;

export interface SourceScope {
  sourceProof?: TelegramSourceProof;
  officerPermission?: boolean;
  chatId: string;
  firstPosition: number;
  enrolledSecond: number;
  afterTelegramId: number | null;
}

interface Checkpoint {
  sourceProof?: TelegramSourceProof;
  officerPermission?: boolean;
  firstPosition: number;
  enrolledSecond: number;
  afterTelegramId: number | null;
  lastSourceChange: number;
  bankSources: number;
  through: number;
  memory?: ReplyOfferMemory;
}

/** Rebuild from source after a restart, edit, deletion, new evidence exclusion or consent change. On an
 * ordinary new message only inspect rows since the previous checkpoint. No extra transcript is persisted.
 */
export class OfferMemory {
  private readonly checkpoints = new Map<string, Checkpoint>();

  clear(): void { this.checkpoints.clear(); }

  forget(chatId: string): void { this.checkpoints.delete(chatId); }

  read(tx: Tx, scope: SourceScope, contactId: string, through: number): ReplyOfferMemory | undefined {
    const revision = tx.get<{ lastSourceChange: number; bankSources: number }>(
      `SELECT COALESCE((SELECT position FROM message_events WHERE chat_id=:chatId
         AND type IN ('edited','deleted','conflicting_copy') ORDER BY position DESC LIMIT 1),0) AS lastSourceChange,
         (SELECT COUNT(*) FROM telegram_evidence_sources WHERE chat_id=:chatId AND reason='bank_details') AS bankSources`,
      { chatId: scope.chatId })!;
    const prior = this.checkpoints.get(scope.chatId);
    const valid = prior && prior.officerPermission === scope.officerPermission && prior.through <= through && prior.firstPosition === scope.firstPosition && prior.afterTelegramId === scope.afterTelegramId
      && prior.sourceProof?.connector === scope.sourceProof?.connector && prior.sourceProof?.policyKey === scope.sourceProof?.policyKey
      && prior.enrolledSecond === scope.enrolledSecond && prior.lastSourceChange === revision.lastSourceChange
      && prior.bankSources === revision.bankSources ? prior : undefined;
    if (valid?.through === through) return valid.memory;
    const memory = this.recover(tx, scope, contactId, through, valid);
    this.checkpoints.set(scope.chatId, { ...scope, ...revision, through, memory });
    return memory;
  }

  private recover(tx: Tx, scope: SourceScope, contactId: string, through: number, prior?: Checkpoint): ReplyOfferMemory | undefined {
    // Walk the chat-position index backwards; stop as soon as the latest direct offer or withdrawal is found.
    const floor = prior?.through ?? (scope.firstPosition - 1);
    let upper = through;
    let correction: string | undefined;
    const pageSize = 64;
    while (upper > floor) {
      const rows = tx.all<{ text: string | null; position: number }>(
        `SELECT m.position, CASE WHEN m.edited_at_source=1 THEN ${latestEditText} ELSE m.text END AS text
         FROM messages m WHERE ${eligibleReplySources} ${scope.officerPermission ? ' AND ' + permittedDispatchSourceSql : ''}
           ${scope.sourceProof ? 'AND ' + verifiedTelegramSourceSql : ''}
           AND m.direction='incoming' AND m.sender_external_id=:contactId AND m.capture_method='telegram_business_live'
           AND m.position > :floor AND m.position <= :upper ORDER BY m.position DESC LIMIT ${pageSize}`,
        { chatId: scope.chatId, firstPosition: scope.firstPosition, enrolledSecond: scope.enrolledSecond,
          afterTelegramId: scope.afterTelegramId, contactId, floor, upper, ...scope.sourceProof },
      );
      for (const row of rows) {
        for (const event of contactOfferEvents(row.text ?? '')) {
          if (event.kind === 'withdrawal') return undefined;
          if (event.kind === 'offer') return { offer: event.excerpt, ...(correction && { correction }) };
          correction ??= event.excerpt;
        }
      }
      if (rows.length < pageSize) break;
      upper = rows[rows.length - 1]!.position - 1;
    }
    return prior?.memory && correction ? { ...prior.memory, correction } : prior?.memory;
  }
}
