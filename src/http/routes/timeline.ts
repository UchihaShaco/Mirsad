import { ok } from '../../contract/errors.ts';
import { readTimeline } from '../../services/timeline.ts';
import { principalOf, type RouteModule } from '../context.ts';

export const routes: RouteModule = {
  'GET /v1/chats/{chatId}/timeline': (c, deps) => {
    const officer = principalOf(c);
    const chatId = c.req.param('chatId') ?? '';
    return c.json(ok(deps.db.transaction((tx) => readTimeline(tx, officer, chatId, deps.config.telegram))));
  },
};
