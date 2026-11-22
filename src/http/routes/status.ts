/** GET /v1/status (officer only; design section 13). */
import { ok } from '../../contract/errors.ts';
import { readStatus } from '../../services/status.ts';
import type { RouteModule } from '../context.ts';

export const routes: RouteModule = {
  'GET /v1/status': async (c, deps) => {
    const status = await readStatus({
      config: deps.config,
      db: deps.db,
      reviewer: deps.reviewer,
      startedAt: deps.startedAt,
      liveConnectorRunning: deps.telegramLive.running(),
    });
    return c.json(ok(status));
  },
};
