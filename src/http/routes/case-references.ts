/** POST /v1/chats/{chatId}/case-references (extension, design sections 6 and 10). Chat access (404) before the body (400). */
import { ok } from '../../contract/errors.ts';
import { CaseReferenceRequest } from '../../contract/schemas.ts';
import { requireChat } from '../../services/access.ts';
import { recordCaseReference } from '../../services/case-references.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const CREATED = 201;

export const routes: RouteModule = {
  'POST /v1/chats/{chatId}/case-references': async (c, deps) => {
    const officer = principalOf(c);
    const chatId = c.req.param('chatId') ?? '';
    deps.db.transaction((tx) => requireChat(tx, officer, chatId));
    const body = await parseJsonBody(c, CaseReferenceRequest);
    const result = deps.db.transaction((tx) => recordCaseReference(tx, officer, chatId, body));
    return c.json(ok(result), CREATED);
  },
};
