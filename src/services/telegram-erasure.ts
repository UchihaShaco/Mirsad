import { chatScopeOf, isChatInScope } from '../adapters/telegram/chat-scope.ts';
import { findLiveBindings } from '../adapters/telegram/live-connector.ts';
import { connectionHash } from '../adapters/telegram/message-proof.ts';
import type { AppDeps } from '../app.ts';
import { AppError } from '../contract/errors.ts';
import type { TelegramEraseResponse } from '../contract/schemas.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { findPrincipalById } from '../storage/repos/principals.ts';
import { requireChat } from './access.ts';

type Reason = keyof TelegramEraseResponse['excluded'];
export type Result = Reason | 'removed' | 'failed' | 'uncertain' | 'pending';
export type Counts = Record<Result, number>;
export type Receipt = Record<string, Counts>;
export interface Candidate { id: string; chatId: string; number: number; own: boolean; second: number; kind: string }
const emptyCounts = (): Counts => ({ unverified: 0, expired: 0, rights: 0, unsupported: 0, removed: 0, failed: 0, uncertain: 0, pending: 0 });

export function report(receipt: Receipt, active: boolean): TelegramEraseResponse {
  const result: TelegramEraseResponse = { status: active ? 'in_progress' : 'completed', total: 0, removed: 0, skipped: 0,
    failed: 0, uncertain: 0, pending: 0, excluded: { unverified: 0, expired: 0, rights: 0, unsupported: 0 }, remainingChats: [], manualHistoryMayRemain: true };
  for (const [chatId, counts] of Object.entries(receipt)) {
    const skipped = counts.unverified + counts.expired + counts.rights + counts.unsupported;
    // A process that stopped before reserving its next batch never sent it. A reserved batch stays uncertain.
    const pending = active ? counts.pending : 0;
    const failed = counts.failed + (active ? 0 : counts.pending);
    result.total += skipped + counts.removed + counts.uncertain + failed + pending;
    result.skipped += skipped; result.removed += counts.removed; result.uncertain += counts.uncertain;
    result.failed += failed; result.pending += pending;
    for (const reason of ['unverified', 'expired', 'rights', 'unsupported'] as const) result.excluded[reason] += counts[reason];
    if (skipped + counts.uncertain + failed + pending > 0) result.remainingChats.push({ chatId, removed: counts.removed, skipped, uncertain: counts.uncertain, failed, pending });
  }
  return result;
}

export function requireErasureControl(tx: Tx, officer: Principal, chatId: string) {
  const current = findPrincipalById(tx, officer.id);
  if (current?.kind !== 'officer' || current.disabled || current.workspace_id !== officer.workspaceId)
    throw AppError.of('forbidden_for_principal', 'An active officer is required.');
  const chat = requireChat(tx, officer, chatId);
  if (chat.ai_mode === 'officer_control' && chat.controller_id !== officer.id)
    throw AppError.of('not_controller', 'A selected conversation is under another officer’s control.');
  return chat;
}

interface SourceRow {
  id: string; deleted_at_source: number;
  connection_hash: string | null; chat_number: number | null; message_number: number | null;
  sent_second: number | null; own_send: number | null; content_kind: string | null; connector_id: string | null;
  removal: 'removed' | 'uncertain' | 'failed' | null;
}

export function ageOrKind(second: number, kind: string, now: number): Reason | null {
  const age = now - second;
  if (age >= 48 * 3600) return 'expired';
  return age < 0 || kind === 'unsupported' || (kind === 'dice' && age <= 24 * 3600) ? 'unsupported' : null;
}

export function prepareTelegramErasure(tx: Tx, deps: AppDeps, officer: Principal, ids: string[]) {
  const receipt: Receipt = {};
  const candidates: Candidate[] = [];
  const bindings = findLiveBindings(tx);
  const binding = bindings.length === 1 ? bindings[0] : undefined;
  const connection = deps.config.telegram.approvedConnectionId;
  const scope = chatScopeOf(deps.config.telegram);
  const now = Math.floor(Date.parse(tx.now()) / 1000);
  for (const chatId of ids) {
    const chat = requireErasureControl(tx, officer, chatId);
    const counts = emptyCounts(); receipt[chat.id] = counts;
    const managed = binding && connection && binding.account.id === chat.channel_account_id && binding.ownerUserId !== Number(chat.external_chat_id)
      && Number(chat.external_chat_id) > 0 && isChatInScope(scope, chat.external_chat_id, binding.ownerUserId);
    const rows = tx.all<SourceRow>(`SELECT m.id,m.deleted_at_source,p.connection_hash,p.chat_number,p.message_number,
      p.sent_second,p.own_send,p.content_kind,p.connector_id,p.removal
      FROM messages m LEFT JOIN telegram_message_proofs p ON p.message_id=m.id
      WHERE m.chat_id=:chat ORDER BY m.position`, { chat: chatId });
    for (const row of rows) {
      if (row.removal === 'removed' || row.removal === 'uncertain') { counts[row.removal]++; continue; }
      if (!managed || !binding || !connection) { counts.unsupported++; continue; }
      if (row.connection_hash !== connectionHash(connection) || row.connector_id !== binding.principal.id
          || row.chat_number !== Number(chat.external_chat_id) || !row.message_number || !row.sent_second || !row.content_kind) {
        counts.unverified++; continue;
      }
      const skip = ageOrKind(row.sent_second, row.content_kind, now);
      if (skip || row.deleted_at_source) { counts[skip ?? 'unverified']++; continue; }
      counts.pending++;
      candidates.push({ id: row.id, chatId, number: row.message_number, own: row.own_send === 1, second: row.sent_second, kind: row.content_kind });
    }
  }
  return { receipt, candidates, owner: binding?.ownerUserId, connector: binding?.principal.id, connection };
}
