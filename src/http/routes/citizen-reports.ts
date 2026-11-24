/**
 * POST /v1/citizen-reports: an officer imports a scam report a citizen shared from Mirsad Android (report v1).
 * 201 with the new message, 200 when the same report was imported before. The body carries the report as the file
 * holds it; nothing in it is forwarded anywhere.
 */
import { ok } from '../../contract/errors.ts';
import { CitizenReportImportRequest } from '../../contract/schemas.ts';
import { importCitizenReport } from '../../services/citizen-reports.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const CREATED = 201;
const OK = 200;

export const routes: RouteModule = {
  'POST /v1/citizen-reports': async (c, deps) => {
    const officer = principalOf(c);
    const body = await parseJsonBody(c, CitizenReportImportRequest);
    const result = deps.db.transaction((tx) => importCitizenReport(tx, officer, body, deps.config));
    if (result.created) deps.workers.capture.wake();
    return c.json(ok(result), result.created ? CREATED : OK);
  },
};
