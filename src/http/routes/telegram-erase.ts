import { BotApiError } from '../../adapters/telegram/bot-api.ts';
import { findLiveBindings } from '../../adapters/telegram/live-connector.ts';
import { addressBelongsToChat, connectionHash } from '../../adapters/telegram/message-proof.ts';
import { chatScopeOf, isChatInScope } from '../../adapters/telegram/chat-scope.ts';
import { AppError, ok } from '../../contract/errors.ts';
import { EraseRequest } from '../../contract/schemas.ts';
import { requireChat } from '../../services/access.ts';
import { erasureTargets } from '../../services/erasure-targets.ts';
import { ageOrKind, type Candidate, prepareTelegramErasure, report, requireErasureControl, type Receipt, type Result } from '../../services/telegram-erasure.ts';
import type { Db, Tx } from '../../storage/db.ts';
import { principalOf, type RouteHandler, type RouteModule } from '../context.ts';
import { IDEMPOTENCY_REPLAYED_HEADER, requireIdempotencyKey, withIdempotency } from '../middleware/idempotency.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const running = new WeakMap<Db, Set<string>>();
const erase: RouteHandler = async (c, deps) => {
  const officer = principalOf(c);
  const chatId = c.req.param('chatId') ?? null;
  const key = requireIdempotencyKey(c);
  const scope = 'erase-telegram/' + (chatId ?? 'inbox');
  const operation = JSON.stringify([officer.id, scope, key]);
  const body = await parseJsonBody(c, EraseRequest);
  const active = running.get(deps.db) ?? new Set<string>();
  running.set(deps.db, active);
  let plan: ReturnType<typeof prepareTelegramErasure> | undefined;
  const result = deps.db.transaction(tx => {
    if (chatId !== null) requireChat(tx, officer, chatId);
    const stored = withIdempotency(tx, officer, scope, key, body, () => {
      const { targets, snapshot } = erasureTargets(tx, officer, chatId);
      if (snapshot !== body.expectedSnapshot) throw AppError.of('revision_conflict', 'The conversation changed. Refresh the erasure preview.');
      plan = prepareTelegramErasure(tx, deps, officer, targets.map(chat => chat.id));
      return { status: 200, body: plan.receipt };
    });
    if (stored.replayed) for (const id of Object.keys(stored.body as Receipt)) requireChat(tx, officer, id);
    return stored;
  });
  c.header('Cache-Control', 'no-store');
  const receipt = result.body as Receipt;
  if (result.replayed || !plan) {
    c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return c.json(ok(report(receipt, active.has(operation))));
  }
  const { candidates, connection, connector, owner } = plan;
  const save = (tx: Tx) => tx.run('UPDATE idempotency_keys SET response_body=? WHERE principal_id=? AND scope=? AND key=?',
    [JSON.stringify(receipt), officer.id, scope, key]);
  const move = (from: Result, to: Result, items: Candidate[]) => {
    for (const item of items) { receipt[item.chatId]![from]--; receipt[item.chatId]![to]++; }
  };
  const settle = (to: Result, items: Candidate[]) => deps.db.transaction(tx => { move('pending', to, items); save(tx); });
  if (!candidates.length) return c.json(ok(report(receipt, false)));
  const client = deps.telegramEraser;
  if (!client || !connection || !owner || !connector || !deps.telegramLive.running()) {
    settle('unsupported', candidates);
    return c.json(ok(report(receipt, false)));
  }
  active.add(operation);
  try {
    let rights: Record<string, boolean> = {};
    try {
      const info = await client.getBusinessConnection(connection);
      if (info.id === connection && info.is_enabled && info.user.id === owner) rights = info.rights ?? {};
    } catch {
      settle('failed', candidates);
      return c.json(ok(report(receipt, false)));
    }
    const allowed = candidates.filter(row => rights.can_delete_all_messages || (row.own && rights.can_delete_sent_messages));
    settle('rights', candidates.filter(row => !rights.can_delete_all_messages && !(row.own && rights.can_delete_sent_messages)));
    const byChat = new Map<string, Candidate[]>();
    for (const row of allowed) {
      const group = byChat.get(row.chatId);
      if (group) group.push(row); else byChat.set(row.chatId, [row]);
    }
    for (const [id, items] of byChat) {
      for (let start = 0; start < items.length; start += 100) {
        const batch = items.slice(start, start + 100);
        const reserved = deps.db.transaction(tx => {
          const fresh = findLiveBindings(tx);
          const chat = requireErasureControl(tx, officer, id);
          const sameBinding = fresh.length === 1 && fresh[0]?.principal.id === connector && fresh[0].account.id === chat.channel_account_id;
          const inScope = isChatInScope(chatScopeOf(deps.config.telegram), chat.external_chat_id, owner);
          if (!sameBinding || !inScope || !deps.telegramLive.running()) { move('pending', 'unsupported', batch); save(tx); return []; }
          const ready: Candidate[] = [];
          for (const item of batch) {
            const skip = ageOrKind(item.second, item.kind, Math.floor(Date.parse(tx.now()) / 1000));
            if (skip) { move('pending', skip, [item]); continue; }
            const row = tx.get<{ removal: 'removed'|'uncertain'|'failed'|null; deleted: number }>(`SELECT p.removal,m.deleted_at_source AS deleted
              FROM telegram_message_proofs p JOIN messages m ON m.id=p.message_id WHERE p.message_id=? AND m.chat_id=? AND p.connector_id=?
                AND p.connection_hash=? AND p.chat_number=? AND p.message_number=?`,
            [item.id, id, connector, connectionHash(connection), Number(chat.external_chat_id), item.number]);
            const unique = addressBelongsToChat(tx, connector, connection, item.number, Number(chat.external_chat_id));
            if (!row || row.deleted || !unique || row.removal === 'removed' || row.removal === 'uncertain') {
              move('pending', row?.removal ?? 'unsupported', [item]); continue;
            }
            tx.run("UPDATE telegram_message_proofs SET removal='uncertain' WHERE message_id=?", [item.id]);
            ready.push(item);
          }
          move('pending', 'uncertain', ready); save(tx); return ready;
        });
        if (!reserved.length) continue;
        let outcome: 'removed'|'failed'|'uncertain' = 'uncertain';
        try {
          if (await client.deleteBusinessMessages(connection, reserved.map(item => item.number))) outcome = 'removed';
        } catch (error) {
          if (error instanceof BotApiError && error.code === 'api_error' && error.status !== null && error.status >= 400 && error.status < 500) outcome = 'failed';
        }
        deps.db.transaction(tx => {
          for (const item of reserved) {
            const confirmed = tx.get("SELECT 1 AS yes FROM telegram_message_proofs WHERE message_id=? AND removal='removed'", [item.id]);
            const final = confirmed ? 'removed' : outcome;
            if (final === 'uncertain') continue;
            tx.run('UPDATE telegram_message_proofs SET removal=? WHERE message_id=?', [final, item.id]);
            move('uncertain', final, [item]);
          }
          save(tx);
        });
      }
    }
  } finally { active.delete(operation); }
  deps.db.transaction(tx => { for (const id of Object.keys(receipt)) requireChat(tx, officer, id); });
  return c.json(ok(report(receipt, false)));
};

export const routes: RouteModule = { 'POST /v1/chats/{chatId}/erase-telegram': erase, 'POST /v1/inbox/erase-telegram': erase };
