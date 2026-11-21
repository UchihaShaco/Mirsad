import { ok } from '../../contract/errors.ts';
import type { MeResponse } from '../../contract/schemas.ts';
import { principalOf, type RouteModule } from '../context.ts';

export const routes: RouteModule = {
  'GET /v1/me': (c) => {
    const { id, kind, displayName, workspaceId } = principalOf(c);
    const data: MeResponse = { principal: { id, kind, displayName, workspaceId } };
    return c.json(ok(data));
  },
};
