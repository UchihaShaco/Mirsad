/** The chats table: one row per conversation of a channel account (design section 4). */
import type { AiMode, Direction, InboxStatus, InitiatedBy, InitiationBasis } from '../../contract/enums.ts';
import type { Tx } from '../db.ts';
import { newId } from '../ids.ts';
import type { ChatRow } from '../rows.ts';

export function findChatById(tx: Tx, chatId: string): ChatRow | undefined {
  return tx.get<ChatRow>('SELECT * FROM chats WHERE id = :chatId', { chatId });
}

export function findChatByExternalId(
  tx: Tx,
  workspaceId: string,
  channelAccountId: string,
  externalChatId: string,
): ChatRow | undefined {
  return tx.get<ChatRow>(
    `SELECT * FROM chats
     WHERE workspace_id = :workspaceId AND channel_account_id = :channelAccountId AND external_chat_id = :externalChatId`,
    { workspaceId, channelAccountId, externalChatId },
  );
}

export interface InsertChatInput {
  workspaceId: string;
  channelAccountId: string;
  externalChatId: string;
  displayLabel: string;
  createdVia: 'ingest' | 'register';
  createdBy: string;
  inboxStatus: InboxStatus;
}

export function insertChat(tx: Tx, input: InsertChatInput): ChatRow {
  const at = tx.now();
  const row = tx.get<ChatRow>(
    `INSERT INTO chats (id, workspace_id, channel_account_id, external_chat_id, display_label, created_via, created_by,
       inbox_status, ai_mode, created_at, updated_at)
     VALUES (:id, :workspaceId, :channelAccountId, :externalChatId, :displayLabel, :createdVia, :createdBy,
       :inboxStatus, 'not_started', :at, :at)
     RETURNING *`,
    { id: newId('chat'), ...input, at },
  );
  if (!row) throw new Error('chat_insert_failed');
  return row;
}

/** Fields intake bookkeeping may set; each is written only when present in the patch. */
export interface ChatBookkeepingPatch {
  firstObservedDirection?: Direction;
  initiatedBy?: InitiatedBy;
  initiationBasis?: InitiationBasis;
  contactExternalId?: string;
  contactDisplayName?: string;
  contactPhoneRaw?: string;
}

const PATCH_COLUMNS: Record<keyof ChatBookkeepingPatch, string> = {
  firstObservedDirection: 'first_observed_direction',
  initiatedBy: 'initiated_by',
  initiationBasis: 'initiation_basis',
  contactExternalId: 'contact_external_id',
  contactDisplayName: 'contact_display_name',
  contactPhoneRaw: 'contact_phone_raw',
};

/** Applies the patch, moves updated_at to now and returns the stored row. */
export function updateChatBookkeeping(tx: Tx, chatId: string, patch: ChatBookkeepingPatch): ChatRow {
  const keys = (Object.keys(PATCH_COLUMNS) as (keyof ChatBookkeepingPatch)[]).filter((k) => patch[k] !== undefined);
  const sets = keys.map((k) => `${PATCH_COLUMNS[k]} = :${k}`);
  const params: Record<string, string> = { chatId, at: tx.now() };
  for (const k of keys) params[k] = patch[k] as string;
  const row = tx.get<ChatRow>(
    `UPDATE chats SET ${[...sets, 'updated_at = :at'].join(', ')} WHERE id = :chatId RETURNING *`,
    params,
  );
  if (!row) throw new Error('chat_update_failed');
  return row;
}

export interface ChatModeUpdate {
  aiMode: AiMode;
  controllerId: string | null;
  revision: number;
}

/** Writes a control change: mode, controller, revision, and the chat leaves New inbound. */
export function updateChatMode(tx: Tx, chatId: string, update: ChatModeUpdate): ChatRow {
  const row = tx.get<ChatRow>(
    `UPDATE chats SET ai_mode = :aiMode, controller_id = :controllerId, revision = :revision,
       inbox_status = 'open', updated_at = :at
     WHERE id = :chatId RETURNING *`,
    { chatId, ...update, at: tx.now() },
  );
  if (!row) throw new Error('chat_update_failed');
  return row;
}

/** Stores the normalized contact phone (called by the watchlist's onContactPhoneKnown, Task 7). */
export function setContactPhoneE164(tx: Tx, chatId: string, e164: string): void {
  tx.run('UPDATE chats SET contact_phone_e164 = :e164 WHERE id = :chatId', { chatId, e164 });
}

export interface ListChatsFilter {
  workspaceId: string;
  channelAccountIds: string[];
  inboxStatus?: InboxStatus;
  limit: number;
  offset: number;
}

export const visibleInboxChatSql = 'NOT EXISTS (SELECT 1 FROM chat_erasure_fences f WHERE f.chat_id=chats.id AND f.hidden=1)';

function filterSql(filter: ListChatsFilter): { where: string; params: Record<string, string | number> } {
  const params: Record<string, string | number> = { workspaceId: filter.workspaceId };
  const accountParams = filter.channelAccountIds.map((id, i) => {
    params[`acct${i}`] = id;
    return `:acct${i}`;
  });
  let where = `workspace_id = :workspaceId AND channel_account_id IN (${accountParams.join(', ')}) AND ${visibleInboxChatSql}`;
  if (filter.inboxStatus) {
    where += ' AND inbox_status = :inboxStatus';
    params.inboxStatus = filter.inboxStatus;
  }
  return { where, params };
}

/** Chats of the given accounts, most recently active first, with the unpaged total. */
export function listChatRows(tx: Tx, filter: ListChatsFilter): { rows: ChatRow[]; total: number } {
  if (filter.channelAccountIds.length === 0) return { rows: [], total: 0 };
  const { where, params } = filterSql(filter);
  const total = tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chats WHERE ${where}`, params)?.n ?? 0;
  const rows = tx.all<ChatRow>(
    `SELECT * FROM chats WHERE ${where} ORDER BY updated_at DESC, id LIMIT :limit OFFSET :offset`,
    { ...params, limit: filter.limit, offset: filter.offset },
  );
  return { rows, total };
}
