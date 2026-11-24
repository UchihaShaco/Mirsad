/** Pause, take over and resume (design section 8). Chat access (404) is checked before the body (400). */
import { ok } from '../../contract/errors.ts';
import { ControlRequest } from '../../contract/schemas.ts';
import { requireChat } from '../../services/access.ts';
import { applyControl } from '../../services/control.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { parseJsonBody } from '../middleware/validate.ts';

export const routes: RouteModule = {
  'POST /v1/chats/{chatId}/control': async (c, deps) => {
    const officer = principalOf(c);
    const chatId = c.req.param('chatId') ?? '';
    deps.db.transaction((tx) => requireChat(tx, officer, chatId));
    const body = await parseJsonBody(c, ControlRequest);
    const result = deps.db.transaction((tx) => applyControl(tx, officer, chatId, body.action, body.expectedRevision));
    // Resume can queue reviews; Pause and Take over invalidate any active reply draft immediately.
    deps.workers.review.wake();
    return c.json(ok(result));
  },
};
