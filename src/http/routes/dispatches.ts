import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ok } from '../../contract/errors.ts';
import { DispatchRequest } from '../../contract/schemas.ts';
import { dispatchChats } from '../../services/dispatch.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { IDEMPOTENCY_REPLAYED_HEADER, requireIdempotencyKey, withIdempotency } from '../middleware/idempotency.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const OK = 200;
const IDEMPOTENCY_SCOPE = 'dispatch';

export const routes: RouteModule = {
  'POST /v1/dispatches': async (c, deps) => {
    const officer = principalOf(c);
    const key = requireIdempotencyKey(c);
    const body = await parseJsonBody(c, DispatchRequest);
    const result = deps.db.transaction((tx) =>
      withIdempotency(tx, officer, IDEMPOTENCY_SCOPE, key, body, () => ({
        status: OK,
        body: ok(dispatchChats(tx, officer, body.chatIds)),
      })),
    );
    if (result.replayed) c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    else deps.workers.review.wake();
    return c.json(result.body as object, result.status as ContentfulStatusCode);
  },
};
