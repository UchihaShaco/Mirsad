import { AppError, fail } from '../contract/errors.ts';
import { CHANNEL_LABELS } from '../contract/labels.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { record } from '../storage/repos/case-actions.ts';
import { findPrincipalById } from '../storage/repos/principals.ts';
import { requireChat } from './access.ts';
import { rememberErasedSource } from './chat-erasure-fence.ts';
import { assertRevision } from './control.ts';
import { getTelegramReplyHold } from './telegram-reply-holds.ts';

function forgetWatchlistEvidence(tx: Tx, chatId: string): void {
  const touched = tx.all<{ entry_id: string }>(`SELECT entry_id FROM watchlist_observations WHERE chat_id=?
    UNION SELECT entry_id FROM watchlist_matches WHERE chat_id=?`, [chatId, chatId]);
  tx.run('DELETE FROM watchlist_observations WHERE chat_id=?', [chatId]);
  tx.run('DELETE FROM watchlist_matches WHERE chat_id=?', [chatId]);
  for (const { entry_id: id } of touched) {
    const remaining = tx.get<{ oldest: string | null; newest: string | null }>(`SELECT min(at) AS oldest,max(at) AS newest FROM
      (SELECT observed_at AS at FROM watchlist_observations WHERE entry_id=? UNION ALL
       SELECT matched_at AS at FROM watchlist_matches WHERE entry_id=?)`, [id, id]);
    if (!remaining?.oldest) {
      tx.run('DELETE FROM stream_events WHERE watchlist_entry_id=?', [id]);
      tx.run('DELETE FROM watchlist_reviews WHERE entry_id=?', [id]);
      tx.run('DELETE FROM watchlist_entries WHERE id=?', [id]);
      continue;
    }
    // A shared number is still another case's evidence. Its summary must reflect only surviving sources.
    tx.run(`UPDATE watchlist_entries SET first_seen_at=?,last_seen_at=?,revision=revision+1,updated_at=?,
      display=coalesce((SELECT source_representation FROM watchlist_observations WHERE entry_id=? ORDER BY observed_at,id LIMIT 1),
        (SELECT source_representation FROM watchlist_matches WHERE entry_id=? ORDER BY matched_at,id LIMIT 1)),
      new_evidence_since_review=CASE WHEN status IN ('approved','cleared') AND EXISTS (
        SELECT 1 FROM watchlist_observations WHERE entry_id=? AND observed_at>COALESCE(
          (SELECT max(decided_at) FROM watchlist_reviews WHERE entry_id=?),'')) THEN 1 ELSE 0 END
      WHERE id=?`, [remaining.oldest, remaining.newest, tx.now(), id, id, id, id, id]);
  }
}

function markErasureFence(tx: Tx, chatId: string): number {
  const highest = tx.get<{ n: number }>(`SELECT max(
    coalesce((SELECT max(CAST(substr(source_message_id,4) AS INTEGER)) FROM messages WHERE chat_id=?
      AND capture_method='telegram_business_live' AND source_message_id GLOB 'tg:[0-9]*'),0),
    coalesce((SELECT telegram_id FROM chat_erasure_fences WHERE chat_id=?),0)) AS n`, [chatId, chatId])!.n;
  const cutoff = Math.ceil(Date.parse(tx.now()) / 1000);
  tx.run(`INSERT INTO chat_erasure_fences(chat_id,cutoff_second,telegram_id,hidden) VALUES (?,?,?,1)
    ON CONFLICT(chat_id) DO UPDATE SET cutoff_second=max(cutoff_second,excluded.cutoff_second),
    telegram_id=excluded.telegram_id,hidden=1`, [chatId, cutoff, highest]);
  for (const row of tx.all<{ id: string }>('SELECT source_message_id AS id FROM messages WHERE chat_id=? AND source_message_id IS NOT NULL', [chatId])) {
    rememberErasedSource(tx, chatId, 'message', row.id);
  }
  for (const row of tx.all<{ id: string }>('SELECT source_event_id AS id FROM message_events WHERE chat_id=? AND source_event_id IS NOT NULL', [chatId])) {
    rememberErasedSource(tx, chatId, 'event', row.id);
  }
  return highest;
}

/** Erase one authorized chat in the caller's transaction. Keep only replay prevention, current controls and account routing. */
export function eraseChatHistory(tx: Tx, officer: Principal, chatId: string, expectedRevision: number):
    { chatId: string; revision: number; position: number } {
  const activeOfficer = findPrincipalById(tx, officer.id);
  if (officer.kind !== 'officer' || activeOfficer?.kind !== 'officer' || activeOfficer.disabled ||
      activeOfficer.workspace_id !== officer.workspaceId) {
    throw AppError.of('forbidden_for_principal', 'An active officer is required.');
  }
  const chat = requireChat(tx, officer, chatId);
  assertRevision(chat, expectedRevision);
  if (chat.controller_id && chat.controller_id !== officer.id) throw AppError.of('not_controller', 'Another officer controls this chat.');
  if (tx.get('SELECT 1 FROM telegram_pending_sends WHERE chat_id=? AND expires_at>?', [chatId, tx.now()])) {
    throw AppError.of('invalid_transition', 'A Telegram send is in progress. Retry when it finishes.');
  }
  if (tx.get(`SELECT 1 FROM whatsapp_reply_attempts a JOIN messages m ON m.id=a.message_id
    WHERE m.chat_id=? AND a.state='sending' AND unixepoch(a.created_at)>unixepoch('now')-120`, [chatId])) {
    throw AppError.of('invalid_transition', 'A WhatsApp send is in progress. Retry when it finishes.');
  }
  tx.run('DELETE FROM telegram_pending_sends WHERE chat_id=?', [chatId]);
  const telegramId = markErasureFence(tx, chatId);
  const hold = getTelegramReplyHold(tx, chatId);
  const stop = hold.contactOptedOut ? tx.get<{ id: string }>(`SELECT id FROM case_actions WHERE chat_id=?
    AND type='telegram_contact_opted_out' ORDER BY position DESC LIMIT 1`, [chatId]) : undefined;
  if (stop) {
    // A legacy STOP without a qualifier defaults to explicit reopening. No text or source link survives.
    tx.run(`UPDATE case_actions SET message_id=NULL,detail=json_object('emphatic',coalesce(json_extract(detail,'$.emphatic'),1))
      WHERE id=?`, [stop.id]);
  }
  tx.run(`INSERT OR IGNORE INTO erased_evidence_files(storage_key,chat_id) SELECT storage_key,chat_id FROM artifacts WHERE chat_id=?
    UNION SELECT 'captures/'||?||'/'||chat_id||'/'||id||'.png',chat_id FROM captures WHERE chat_id=?`,
    [chatId, chat.workspace_id, chatId]);
  // Keep only the spent key. The original response and its request fingerprint can both derive from private text.
  const expired = fail({ code: 'history_erased', message: 'The history for this operation was erased.' });
  tx.run(`UPDATE idempotency_keys SET response_body=?,request_sha256='',status_code=410 WHERE scope=?
    OR (scope IN ('dispatch','dispatch_by_phone') AND EXISTS (SELECT 1 FROM json_tree(response_body) WHERE value=?))`,
    [JSON.stringify(expired), 'officer-message:' + chatId, chatId]);
  forgetWatchlistEvidence(tx, chatId);
  for (const table of ['telegram_dispatch_permissions', 'telegram_dispatch_contacts', 'telegram_evidence_sources', 'dispatch_briefs', 'captures', 'artifacts',
    'findings', 'case_references', 'case_details', 'reviews', 'stream_events']) {
    tx.run(`DELETE FROM ${table} WHERE chat_id=?`, [chatId]);
  }
  tx.run('DELETE FROM case_actions WHERE chat_id=? AND id IS NOT ?', [chatId, stop?.id ?? null]);
  tx.run('DELETE FROM message_events WHERE chat_id=?', [chatId]);
  tx.run('DELETE FROM messages WHERE chat_id=?', [chatId]);
  const source = tx.get<{ source: keyof typeof CHANNEL_LABELS }>('SELECT source FROM channel_accounts WHERE id=?', [chat.channel_account_id])!.source;
  const revision = chat.revision + 1;
  const mode = hold.officerReview && chat.ai_mode !== 'officer_control' ? 'paused' : chat.ai_mode;
  tx.run(`UPDATE chats SET revision=?,updated_at=?,display_label=?,contact_display_name=NULL,
    contact_external_id=NULL,contact_phone_raw=NULL,contact_phone_e164=NULL,first_observed_direction=NULL,
    initiated_by='unknown',initiation_basis=NULL,ai_mode=? WHERE id=?`,
    [revision, tx.now(), `${CHANNEL_LABELS[source]} chat`, mode, chatId]);
  const { position } = record(tx, { chatId, workspaceId: chat.workspace_id, actorId: officer.id,
    type: 'chat_test_started', revision, detail: { erased: true, telegramId } });
  return { chatId, revision, position };
}
