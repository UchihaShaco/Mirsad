import { ok } from '../../contract/errors.ts';
import type { RouteModule } from '../context.ts';

export const routes: RouteModule = {
  'GET /healthz': (c) => c.json(ok({ status: 'ok' as const })),
};
