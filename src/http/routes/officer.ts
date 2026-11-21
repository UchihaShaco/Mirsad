/**
 * The composer and decisions (design section 8). Checked in order: chat access (404), then the request (400),
 * then for the composer the idempotent replay, then the takeover checks inside the service.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ok } from '../../contract/errors.ts';
import { OfficerDecisionRequest, OfficerMessageRequest } from '../../contract/schemas.ts';
import { requireChat } from '../../services/access.ts';
import { recordDecision, submitOfficerMessage } from '../../services/officer.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { IDEMPOTENCY_REPLAYED_HEADER, requireIdempotencyKey, withIdempotency } from '../middleware/idempotency.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const CREATED = 201;
const OK = 200;
const idempotencyScope = (chatId: string): string => `officer-message:${chatId}`;

export const routes: RouteModule = {
  'POST /v1/chats/{chatId}/officer-messages': async (c, deps) => {
    const officer = principalOf(c);
    const chatId = c.req.param('chatId') ?? '';
    deps.db.transaction((tx) => requireChat(tx, officer, chatId));
    const key = requireIdempotencyKey(c);
    const body = await parseJsonBody(c, OfficerMessageRequest);
    const result = deps.db.transaction((tx) =>
      withIdempotency(tx, officer, idempotencyScope(chatId), key, body, () => ({
        status: CREATED,
        body: ok({ message: submitOfficerMessage(tx, officer, chatId, body) }),
      })),
    );
    if (result.replayed) c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return c.json(result.body as object, result.status as ContentfulStatusCode);
  },
  'POST /v1/chats/{chatId}/officer-decisions': async (c, deps) => {
    const officer = principalOf(c);
    const chatId = c.req.param('chatId') ?? '';
    deps.db.transaction((tx) => requireChat(tx, officer, chatId));
    const body = await parseJsonBody(c, OfficerDecisionRequest);
    const result = deps.db.transaction((tx) => recordDecision(tx, officer, chatId, body));
    return c.json(ok(result), result.created ? CREATED : OK);
  },
};
