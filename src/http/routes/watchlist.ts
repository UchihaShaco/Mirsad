/**
 * GET /v1/watchlist and POST /v1/watchlist/{entryId}/review (design sections 6 and 11). The review route checks entry
 * access (404) before the body (400), as the chat routes check chat access first.
 */
import { ok } from '../../contract/errors.ts';
import { WatchlistReviewRequest } from '../../contract/schemas.ts';
import { currentCursor } from '../../services/chats.ts';
import { listEntries, requireEntryAccess, reviewEntry } from '../../services/watchlist.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { parseJsonBody } from '../middleware/validate.ts';

export const routes: RouteModule = {
  'GET /v1/watchlist': (c, deps) => {
    const officer = principalOf(c);
    const data = deps.db.transaction((tx) => ({ entries: listEntries(tx, officer), cursor: currentCursor(tx, officer.workspaceId) }));
    return c.json(ok(data));
  },
  'POST /v1/watchlist/{entryId}/review': async (c, deps) => {
    const officer = principalOf(c);
    const entryId = c.req.param('entryId') ?? '';
    deps.db.transaction((tx) => requireEntryAccess(tx, officer, entryId));
    const body = await parseJsonBody(c, WatchlistReviewRequest);
    const entry = deps.db.transaction((tx) => reviewEntry(tx, officer, entryId, body));
    return c.json(ok({ entry }));
  },
};
