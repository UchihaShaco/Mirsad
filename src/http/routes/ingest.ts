import type { Context } from 'hono';
import type { AppDeps } from '../../app.ts';
import { ok } from '../../contract/errors.ts';
import { IngestRequest, type IntakeEvent } from '../../contract/schemas.ts';
import { ingest, type IntakeTarget } from '../../services/intake.ts';
import { principalOf, type AppEnv, type RouteModule } from '../context.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const CREATED = 201;
const OK = 200;

/** Shared by both intake routes: one transaction, then wake the workers when something new was stored. */
export function runIntake(c: Context<AppEnv>, deps: AppDeps, target: IntakeTarget, event: IntakeEvent): Response {
  const connector = principalOf(c);
  const result = deps.db.transaction((tx) => ingest(tx, connector, target, event, deps.config));
  const stored = result.messageEventId !== null;
  if (stored) {
    deps.workers.capture.wake();
    deps.workers.review.wake();
  }
  return c.json(ok(result), stored ? CREATED : OK);
}

export const routes: RouteModule = {
  'POST /v1/ingest': async (c, deps) => {
    const body = await parseJsonBody(c, IngestRequest);
    const target: IntakeTarget = {
      source: body.source,
      externalAccountId: body.externalAccountId,
      externalChatId: body.externalChatId,
      chat: body.chat,
    };
    return runIntake(c, deps, target, body.event);
  },
};
