import type { Tx } from '../storage/db.ts';
import { record, type CaseActionDetail } from '../storage/repos/case-actions.ts';
import { directTelegramTextSql } from '../storage/repos/messages.ts';
import { verifiedTelegramSourceSql } from '../adapters/telegram/message-proof.ts';
import type { SourceScope } from '../workers/offer-memory.ts';
import { currentTestMessageSql, readChatTestWindow } from './chat-test-session.ts';
import { getTelegramReplyHold } from './telegram-reply-holds.ts';
import { permittedDispatchSourceSql } from './telegram-dispatch-permission.ts';
import { matchMeeting, type MeetingEvidence, type MeetingTurn } from './meeting-evidence.ts';

export { isRepeatedMeetingQuestion } from './meeting-evidence.ts';

export interface MeetingAssessment { sources: MeetingEvidence; throughPosition: number; firstPosition: number }
export interface LowerConcern { kind: 'meeting_arranged'; assessedAt: string; sources: MeetingEvidence }

function hasContraryEvidence(tx: Tx, chatId: string, firstPosition: number): boolean {
  const hold = getTelegramReplyHold(tx, chatId);
  if (hold.contactOptedOut || hold.officerReview ||
    hold.evidenceItems.some(item => item.reason !== 'location' && item.reason !== 'link')) return true;
  if (tx.get("SELECT 1 FROM watchlist_matches m JOIN watchlist_entries e ON e.id=m.entry_id WHERE m.chat_id=? AND e.status='approved' LIMIT 1", [chatId])) return true;
  return !!tx.get("SELECT 1 FROM findings f JOIN messages m ON m.id=f.message_id WHERE f.chat_id=? AND f.kind='suspected_fraud' AND m.position>=? LIMIT 1", [chatId, firstPosition]);
}

/** The caller supplies the actual enrollment window. The reset boundary is also enforced locally for a manual assessment.
 * Untrusted sources are empty turns (episode barriers), never citations. No source details are logged or duplicated. */
export function assessMeeting(tx: Tx, scope: SourceScope): MeetingAssessment | null {
  const window = readChatTestWindow(tx, scope.chatId);
  const firstPosition = Math.max(scope.firstPosition, window.position + 1);
  if (hasContraryEvidence(tx, scope.chatId, firstPosition)) return null;
  const rows = tx.all<MeetingTurn & { eventPosition: number }>(
    'SELECT m.id AS messageId, e.id AS messageEventId, m.direction, e.position AS eventPosition, ' +
    'unixepoch(coalesce(m.sent_at,m.received_at)) AS at, CASE WHEN ' +
    "m.original_captured=1 AND m.deleted_at_source=0 AND m.origin='source' AND e.type IN ('recorded','edited') " +
    "AND (m.direction='outgoing' OR (m.direction='incoming' AND m.sender_external_id=c.external_chat_id)) " +
    `AND ${directTelegramTextSql} ` +
    (scope.sourceProof ? `AND ${verifiedTelegramSourceSql} ` : '') +
    "AND NOT EXISTS (SELECT 1 FROM telegram_evidence_sources b WHERE b.message_id=m.id AND b.reason='bank_details') " +
    "THEN coalesce(e.text,'') ELSE '' END AS text FROM messages m JOIN chats c ON c.id=m.chat_id " +
    'JOIN message_events e ON e.id=(SELECT id FROM message_events WHERE message_id=m.id ORDER BY position DESC LIMIT 1) ' +
    "WHERE m.chat_id=:chatId AND m.capture_method='telegram_business_live' AND e.capture_method='telegram_business_live' " +
    'AND m.position>=:firstPosition AND unixepoch(coalesce(m.sent_at,m.received_at))>=:enrolledSecond ' +
    "AND (:afterTelegramId IS NULL OR (m.source_message_id GLOB 'tg:[0-9]*' AND CAST(substr(m.source_message_id,4) AS INTEGER)>:afterTelegramId)) " +
    'AND ' + currentTestMessageSql + (scope.officerPermission ? ' AND ' + permittedDispatchSourceSql : '') + ' ORDER BY m.position DESC LIMIT 32', {
      chatId: scope.chatId, firstPosition, enrolledSecond: scope.enrolledSecond, afterTelegramId: scope.afterTelegramId, ...window, ...scope.sourceProof,
    },
  );
  const sources = matchMeeting(rows.reverse());
  return sources && { sources, firstPosition, throughPosition: Math.max(...rows.map(r => r.eventPosition)) };
}

/** The incoming/contact watermark and source versions protect queue membership between reply jobs.
 * A normal outgoing Ali acknowledgement can arrive after the assessment without replacing it. */
function superseded(tx: Tx, chatId: string, through: number, first: number, before: number): boolean {
  return !!tx.get(
    'SELECT 1 FROM message_events e JOIN messages m ON m.id=e.message_id ' +
    "WHERE e.chat_id=? AND e.capture_method='telegram_business_live' AND m.position>=? AND e.position>? AND e.position<? " +
    "AND (m.direction IS NOT 'outgoing' OR e.type!='recorded' OR NOT EXISTS " +
    "(SELECT 1 FROM case_actions s WHERE s.message_id=m.id AND s.type='ai_reply_sent')) LIMIT 1",
    [chatId, first, through, before]);
}

interface StoredAssessment { id: string; occurred_at: string; detail: string; position: number }
const latestActionSql = "SELECT id,occurred_at,detail,position FROM case_actions WHERE chat_id=? AND type='lower_concern_assessed'";
function decode(row: StoredAssessment): { evidence: MeetingEvidence; first: number; through: number } {
  const d = JSON.parse(row.detail) as Record<string, string | number>;
  const source = (field: string) => ({ messageId: String(d[field + 'MessageId']), messageEventId: String(d[field + 'EventId']) });
  return { first: Number(d.firstPosition), through: Number(d.throughPosition), evidence: {
    agreement: source('agreement'), time: source('time'), place: source('place'), ...(d.dateMessageId && { date: source('date') }),
  } };
}

function activeAssessment(tx: Tx, chatId: string): StoredAssessment | null {
  const window = readChatTestWindow(tx, chatId);
  const row = tx.get<StoredAssessment>(latestActionSql + ' AND position>? ORDER BY position DESC LIMIT 1', [chatId, window.position]);
  if (!row) return null;
  const { first, through } = decode(row);
  if (superseded(tx, chatId, through, first, Number.MAX_SAFE_INTEGER) || hasContraryEvidence(tx, chatId, first)) return null;
  return row;
}

export function activeLowerConcernActionId(tx: Tx, chatId: string): string | null {
  return activeAssessment(tx, chatId)?.id ?? null;
}

function asLowerConcern(row: StoredAssessment | undefined | null): LowerConcern | null {
  return row ? { kind: 'meeting_arranged', assessedAt: row.occurred_at, sources: decode(row).evidence } : null;
}

export function readLowerConcern(tx: Tx, chatId: string): LowerConcern | null {
  return asLowerConcern(activeAssessment(tx, chatId));
}

/** The reset records exactly the assessment visible at that time. Later watchlist decisions never rewrite it. */
export function readPreviousLowerConcern(tx: Tx, chatId: string): LowerConcern | null {
  return asLowerConcern(tx.get<StoredAssessment>(
    "SELECT a.id,a.occurred_at,a.detail,a.position FROM case_actions reset JOIN case_actions a " +
    "ON a.id=json_extract(reset.detail,'$.archivedLowerConcernActionId') AND a.chat_id=reset.chat_id " +
    "WHERE reset.type='chat_test_started' AND reset.chat_id=? AND a.type='lower_concern_assessed' AND a.position<reset.position " +
    'ORDER BY reset.position DESC LIMIT 1', [chatId]));
}

/** Intended for the same transaction as assessMeeting or the worker's currency check. Rechecking the
 * watermark makes retry safe, and the existing case-action event refreshes the officer's inbox. */
export function recordLowerConcern(tx: Tx, chatId: string, assessment: MeetingAssessment): void {
  const { sources, throughPosition, firstPosition } = assessment;
  if (firstPosition <= readChatTestWindow(tx, chatId).position || hasContraryEvidence(tx, chatId, firstPosition) ||
    superseded(tx, chatId, throughPosition, firstPosition, Number.MAX_SAFE_INTEGER)) return;
  const previous = tx.get<StoredAssessment>(latestActionSql + ' ORDER BY position DESC LIMIT 1', [chatId]);
  if (previous && decode(previous).through === throughPosition) return;
  const chat = tx.get<{ workspace_id: string }>('SELECT workspace_id FROM chats WHERE id=?', [chatId]);
  if (!chat) return;
  const detail: CaseActionDetail = { reason: 'meeting_arranged', throughPosition, firstPosition, messageEventId: sources.agreement.messageEventId };
  for (const [role, source] of Object.entries(sources)) {
    detail[role + 'MessageId'] = source.messageId;
    detail[role + 'EventId'] = source.messageEventId;
  }
  record(tx, { chatId, workspaceId: chat.workspace_id, messageId: sources.agreement.messageId,
    type: 'lower_concern_assessed', actorId: null, detail });
}
