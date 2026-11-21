/** POST /v1/captures/{captureId}/retry (extension, design sections 6 and 9). */
import { ok } from '../../contract/errors.ts';
import { retryCapture } from '../../services/artifacts.ts';
import { principalOf, type RouteModule } from '../context.ts';

export const routes: RouteModule = {
  'POST /v1/captures/{captureId}/retry': (c, deps) => {
    const officer = principalOf(c);
    const captureId = c.req.param('captureId') ?? '';
    const data = deps.db.transaction((tx) => retryCapture(tx, officer, captureId));
    deps.workers.capture.wake();
    return c.json(ok(data));
  },
};
