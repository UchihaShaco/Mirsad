import { AppError, ok } from '../../contract/errors.ts';
import { EraseRequest } from '../../contract/schemas.ts';
import { requireChat } from '../../services/access.ts';
import { eraseChatHistory } from '../../services/chat-erasure.ts';
import { erasureTargets } from '../../services/erasure-targets.ts';
import { flushErasedEvidence } from '../../services/erased-evidence.ts';
import { principalOf, type RouteHandler, type RouteModule } from '../context.ts';
import { IDEMPOTENCY_REPLAYED_HEADER, requireIdempotencyKey, withIdempotency } from '../middleware/idempotency.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const preview: RouteHandler = (c, deps) => {
  const result = deps.db.transaction(tx => erasureTargets(tx, principalOf(c), c.req.param('chatId') ?? null));
  c.header('Cache-Control', 'no-store');
  return c.json(ok({ chatCount: result.targets.length, snapshot: result.snapshot }));
};

const erase: RouteHandler = async (c, deps) => {
  const officer = principalOf(c);
  const chatId = c.req.param('chatId') ?? null;
  const key = requireIdempotencyKey(c);
  const body = await parseJsonBody(c, EraseRequest);
  const result = deps.db.transaction(tx => {
    if (chatId !== null) requireChat(tx, officer, chatId);
    const receipt = withIdempotency(tx, officer, 'erase-local/' + (chatId ?? 'inbox'), key, body, () => {
      const { targets, snapshot } = erasureTargets(tx, officer, chatId);
      if (snapshot !== body.expectedSnapshot) {
        throw AppError.of('revision_conflict', 'The conversation or inbox changed. Check the new preview before erasing.');
      }
      for (const chat of targets) {
        eraseChatHistory(tx, officer, chat.id, chat.revision);
        tx.afterCommit(() => deps.telegramLive.forgetChat?.(chat.id));
      }
      return { status: 200, body: targets.map(chat => chat.id) };
    });
    const ids = receipt.body as string[];
    if (receipt.replayed) for (const id of ids) requireChat(tx, officer, id);
    return { ids, replayed: receipt.replayed };
  });
  const filesPending = await flushErasedEvidence(deps.db, deps.evidenceStore, new Set(result.ids));
  deps.db.checkpointAfterErasure?.();
  deps.workers.review.wake();
  // An erased chat can take its number's last evidence, and with it the number's flag.
  deps.workers.contactSync.wake();
  if (result.replayed) c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  c.header('Cache-Control', 'no-store');
  return c.json(ok({ chatCount: result.ids.length, filesPending }));
};

export const routes: RouteModule = {
  'GET /v1/chats/{chatId}/erase-preview': preview, 'GET /v1/inbox/erase-preview': preview,
  'POST /v1/chats/{chatId}/erase': erase, 'POST /v1/inbox/erase': erase,
};
