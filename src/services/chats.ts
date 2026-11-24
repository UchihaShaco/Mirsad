/** Chat registry and chat summaries (design sections 6 and 7, step 11). */
import { AppError } from '../contract/errors.ts';
import { CHANNEL_LABELS, LABELS } from '../contract/labels.ts';
import type { ChatSummary, ListChatsQuery, RegisterChatRequest } from '../contract/schemas.ts';
import { originLabel } from '../domain/initiation.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import * as caseActions from '../storage/repos/case-actions.ts';
import { findChatByExternalId, insertChat, listChatRows } from '../storage/repos/chats.ts';
import { countMessages } from '../storage/repos/messages.ts';
import { findChannelAccount, findChannelAccountById, findPrincipalById, grantedAccountIds, hasGrant } from '../storage/repos/principals.ts';
import { reviewStatusCounts } from '../storage/repos/reviews.ts';
import { readLowerConcern, readPreviousLowerConcern } from './lower-concern.ts';
import type { ChannelAccountRow, ChatRow } from '../storage/rows.ts';
import { appendStreamEvent } from './stream.ts';
import { getTelegramReplyHold } from './telegram-reply-holds.ts';
import * as watchlist from './watchlist.ts';

/** The workspace's latest stream sequence as an opaque decimal string (design section 6). */
export function currentCursor(tx: Tx, workspaceId: string): string {
  const row = tx.get<{ stream_seq: number }>('SELECT stream_seq FROM workspaces WHERE id = :workspaceId', { workspaceId });
  return String(row?.stream_seq ?? 0);
}

function reviewSummary(tx: Tx, chatId: string): ChatSummary['review'] {
  const counts = reviewStatusCounts(tx, chatId);
  const pending = counts.pending ?? 0;
  const unavailable = counts.unavailable ?? 0;
  const active = pending + (counts.running ?? 0) > 0;
  return { state: unavailable > 0 ? 'unavailable' : active ? 'active' : 'idle', pending, unavailable };
}

function controllerRef(tx: Tx, controllerId: string | null): ChatSummary['controller'] {
  if (controllerId === null) return null;
  const row = findPrincipalById(tx, controllerId);
  return row ? { id: row.id, displayName: row.display_name } : null;
}

function toSummary(tx: Tx, chat: ChatRow, account: ChannelAccountRow, matches: ChatSummary['watchlistMatches']): ChatSummary {
  return {
    id: chat.id,
    source: account.source,
    channelLabel: CHANNEL_LABELS[account.source],
    externalAccountId: account.external_account_id,
    externalChatId: chat.external_chat_id,
    displayLabel: chat.display_label,
    inboxStatus: chat.inbox_status,
    aiMode: chat.ai_mode,
    revision: chat.revision,
    controller: controllerRef(tx, chat.controller_id),
    originLabel: originLabel(chat.initiated_by, chat.first_observed_direction),
    initiatedBy: chat.initiated_by,
    initiationBasis: chat.initiation_basis,
    firstObservedDirection: chat.first_observed_direction,
    intakeAccount: account.is_intake === 1,
    acknowledgementTemplate: account.is_intake === 1 ? LABELS.acknowledgementTemplate : null,
    review: reviewSummary(tx, chat.id),
    telegramReplyHold: getTelegramReplyHold(tx, chat.id),
    watchlistMatches: matches,
    lowerConcern: readLowerConcern(tx, chat.id),
    previousLowerConcern: readPreviousLowerConcern(tx, chat.id),
    messageCount: countMessages(tx, chat.id),
    lastActivityAt: chat.updated_at,
    createdAt: chat.created_at,
  };
}

/** Summaries for chats the caller already passed the access check for. */
export function buildChatSummaries(tx: Tx, principal: Principal, chatRows: readonly ChatRow[]): ChatSummary[] {
  const matches = watchlist.matchesForChats(tx, principal, chatRows.map((c) => c.id));
  const accounts = new Map<string, ChannelAccountRow>();
  return chatRows.map((chat) => {
    let account = accounts.get(chat.channel_account_id);
    if (!account) {
      account = findChannelAccountById(tx, chat.channel_account_id);
      if (!account) throw new Error('chat_account_missing');
      accounts.set(account.id, account);
    }
    return toSummary(tx, chat, account, matches.get(chat.id) ?? []);
  });
}

export function summaryOf(tx: Tx, principal: Principal, chat: ChatRow): ChatSummary {
  const [summary] = buildChatSummaries(tx, principal, [chat]);
  if (!summary) throw new Error('chat_summary_missing');
  return summary;
}

export interface RegisterChatResult {
  chat: ChatSummary;
  created: boolean;
}

/** Registers an authorized conversation, or returns the existing chat for the same mapping unchanged. */
export function registerChat(tx: Tx, officer: Principal, request: RegisterChatRequest): RegisterChatResult {
  const account = findChannelAccount(tx, officer.workspaceId, request.source, request.externalAccountId);
  if (!account || !hasGrant(tx, officer.id, account.id)) {
    throw AppError.of('account_not_found', 'Channel account not found.');
  }
  const existing = findChatByExternalId(tx, officer.workspaceId, account.id, request.externalChatId);
  if (existing) return { chat: summaryOf(tx, officer, existing), created: false };
  const chat = insertChat(tx, {
    workspaceId: officer.workspaceId,
    channelAccountId: account.id,
    externalChatId: request.externalChatId,
    displayLabel: request.displayLabel,
    createdVia: 'register',
    createdBy: officer.id,
    inboxStatus: 'open',
  });
  appendStreamEvent(tx, { workspaceId: chat.workspace_id, type: 'chat.created', chatId: chat.id, data: { inboxStatus: 'open' } });
  caseActions.record(tx, { chatId: chat.id, workspaceId: chat.workspace_id, type: 'chat_registered', actorId: officer.id });
  return { chat: summaryOf(tx, officer, chat), created: true };
}

export interface ListChatsResult {
  chats: ChatSummary[];
  cursor: string;
  total: number;
}

/** The caller's accessible chats: same workspace and a grant on the chat's account. */
export function listChats(tx: Tx, officer: Principal, query: ListChatsQuery): ListChatsResult {
  const cursor = currentCursor(tx, officer.workspaceId);
  const { rows, total } = listChatRows(tx, {
    workspaceId: officer.workspaceId,
    channelAccountIds: grantedAccountIds(tx, officer.id),
    inboxStatus: query.inboxStatus,
    limit: query.limit,
    offset: query.offset,
  });
  return { chats: buildChatSummaries(tx, officer, rows), cursor, total };
}
