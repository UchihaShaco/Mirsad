/**
 * POST /v1/chats/{chatId}/scammer-flags: an officer flags the chat's contact as a scammer. The number goes to the phone
 * watchlist, approved; the chat lists under Suspects, and with contact sync on the number goes to phones. Chat access
 * (404) before the body (400).
 */
import { ok } from '../../contract/errors.ts';
import { ScammerFlagRequest } from '../../contract/schemas.ts';
import { requireChat } from '../../services/access.ts';
import { withContactSync } from '../../services/contact-sync.ts';
import { flagContactAsScammer } from '../../services/watchlist.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const CREATED = 201;
const OK = 200;

export const routes: RouteModule = {
  'POST /v1/chats/{chatId}/scammer-flags': async (c, deps) => {
    const officer = principalOf(c);
    const chatId = c.req.param('chatId') ?? '';
    deps.db.transaction((tx) => requireChat(tx, officer, chatId));
    const body = await parseJsonBody(c, ScammerFlagRequest);
    const result = deps.db.transaction((tx) => {
      const flagged = flagContactAsScammer(tx, officer, requireChat(tx, officer, chatId), body);
      return deps.config.contactSync ? { ...flagged, entry: withContactSync(tx, [flagged.entry])[0]! } : flagged;
    });
    deps.workers.contactSync.wake();
    return c.json(ok(result), result.created ? CREATED : OK);
  },
};
