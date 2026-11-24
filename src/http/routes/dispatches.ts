import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, ok, type FailureEnvelope, type SuccessEnvelope } from '../../contract/errors.ts';
import { DispatchByPhoneRequest, type DispatchByPhoneResponse, DispatchRequest } from '../../contract/schemas.ts';
import { dispatchPhoneNumber } from '../../domain/phone.ts';
import { requireChat } from '../../services/access.ts';
import { dispatchChats } from '../../services/dispatch.ts';
import { dispatchByPhone } from '../../services/phone-dispatch.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { IDEMPOTENCY_REPLAYED_HEADER, requireIdempotencyKey, withIdempotency } from '../middleware/idempotency.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const OK = 200;
const IDEMPOTENCY_SCOPE = 'dispatch';

export const routes: RouteModule = {
  'POST /v1/dispatches/by-phone': async (c, deps) => {
    const officer = principalOf(c);
    const key = requireIdempotencyKey(c);
    const body = await parseJsonBody(c, DispatchByPhoneRequest);
    const phoneNumber = dispatchPhoneNumber(body.phoneNumber);
    if (!phoneNumber) throw AppError.of('validation_failed', 'Enter one complete international phone number with + or 00.', {
      fields: [{ path: 'phoneNumber', message: 'Use the exact international dialling digits.' }],
    });
    const result = deps.db.transaction((tx) => {
      const stored = withIdempotency(tx, officer, 'dispatch_by_phone', key, { ...body, phoneNumber }, () => ({
        status: OK, body: ok(dispatchByPhone(tx, officer, deps.config.telegram, phoneNumber, body.officerContext,
          { runtimeAvailable: deps.telegramLive.running() && deps.telegramLive.repliesRunning(),
            recordPermission: body.participantPermissionRecorded === true })),
      }));
      const response = stored.body as SuccessEnvelope<DispatchByPhoneResponse> | FailureEnvelope;
      if (stored.replayed && response.success && response.data.outcome === 'dispatched') requireChat(tx, officer, response.data.chatId);
      return { ...stored, body: response };
    });
    if (result.replayed) c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    else if (result.body.success && result.body.data.outcome === 'dispatched') deps.workers.review.wake();
    return c.json(result.body, result.status as ContentfulStatusCode);
  },
  'POST /v1/dispatches': async (c, deps) => {
    const officer = principalOf(c);
    const key = requireIdempotencyKey(c);
    const body = await parseJsonBody(c, DispatchRequest);
    const result = deps.db.transaction((tx) => {
      const stored = withIdempotency(tx, officer, IDEMPOTENCY_SCOPE, key, body, () => ({
        status: OK,
        body: ok(dispatchChats(tx, officer, body.chatIds, body.officerContext, {
          telegram: deps.config.telegram, runtimeAvailable: deps.telegramLive.running() && deps.telegramLive.repliesRunning(),
          recordPermission: body.participantPermissionRecorded === true, expectedTestMode: body.expectedTestMode === true,
          again: body.replyAgain === true, ...(body.replyToMessageId && { replyToMessageId: body.replyToMessageId }),
          ...(body.replyToHeadPosition !== undefined && { replyToHeadPosition: body.replyToHeadPosition }),
        })),
      }));
      if (stored.replayed) for (const chatId of body.chatIds) requireChat(tx, officer, chatId);
      return stored;
    });
    if (result.replayed) c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    else deps.workers.review.wake();
    return c.json(result.body as object, result.status as ContentfulStatusCode);
  },
};
