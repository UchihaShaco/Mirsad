/** GET /v1/status (officer only; design section 13). Worker counts cover the caller's workspace. */
import { ok } from '../../contract/errors.ts';
import { readStatus } from '../../services/status.ts';
import { principalOf, type RouteModule } from '../context.ts';

export const routes: RouteModule = {
  'GET /v1/status': async (c, deps) => {
    const officer = principalOf(c);
    const demoOwner = deps.config.whatsappDemo?.officerId === officer.id;
    const status = await readStatus({
      config: deps.config,
      db: deps.db,
      reviewer: deps.reviewer,
      startedAt: deps.startedAt,
      workspaceId: officer.workspaceId,
      ...(demoOwner && { whatsappDemoStatus: deps.whatsappDemoRunningFor?.(officer.id) ? 'demo_listening' : 'demo_unavailable' }),
      liveConnectorRunning: deps.telegramLive.running(),
    });
    return c.json(ok(status));
  },
};
