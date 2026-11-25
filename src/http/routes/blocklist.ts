/**
 * GET /v1/watchlist/blocklist: the signed phone blocklist the officer may export now (approved numbers they can see).
 * GET /v1/watchlist/blocklist-key: the deployment's public key, for the app's trusted keys. Nothing is stored.
 */
import { ok } from '../../contract/errors.ts';
import { blocklistKey, buildBlocklist, loadSigningKey } from '../../services/blocklist-export.ts';
import { principalOf, type RouteModule } from '../context.ts';

export const routes: RouteModule = {
  'GET /v1/watchlist/blocklist': (c, deps) => {
    const officer = principalOf(c);
    const key = loadSigningKey(deps.config.dataDir);
    const file = deps.db.transaction((tx) => buildBlocklist(tx, officer, key));
    return c.json(ok({ file }));
  },
  'GET /v1/watchlist/blocklist-key': (c, deps) => {
    const officer = principalOf(c);
    const key = loadSigningKey(deps.config.dataDir);
    return c.json(ok(deps.db.transaction((tx) => blocklistKey(tx, officer, key))));
  },
};
