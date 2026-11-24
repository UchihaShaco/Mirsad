import { ok } from '../../contract/errors.ts';
import { InvestigationOpenerRequest } from '../../contract/schemas.ts';
import { draftInvestigationOpener } from '../../services/investigation-opener.ts';
import type { RouteModule } from '../context.ts';
import { parseJsonBody } from '../middleware/validate.ts';

export const routes: RouteModule = {
  'POST /v1/investigation-opener': async (c) => {
    const request = await parseJsonBody(c, InvestigationOpenerRequest);
    return c.json(ok({ draft: draftInvestigationOpener(request) }));
  },
};
