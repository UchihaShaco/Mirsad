import { IntakeEvent } from '../../contract/schemas.ts';
import type { RouteModule } from '../context.ts';
import { parseJsonBody } from '../middleware/validate.ts';
import { runIntake } from './ingest.ts';

export const routes: RouteModule = {
  'POST /v1/chats/{chatId}/events': async (c, deps) => {
    const event = await parseJsonBody(c, IntakeEvent);
    return runIntake(c, deps, { chatId: c.req.param('chatId') ?? '' }, event);
  },
};
