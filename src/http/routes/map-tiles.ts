/**
 * Map tile proxy for the officer places map (design section 6): the browser asks
 * us, we ask the raster provider with a proper User-Agent and cache the tile on
 * disk, so the dashboard's strict same-origin Content-Security-Policy holds.
 */
import { fetchMapTile } from '../../services/map-tiles.ts';
import { principalOf, type RouteModule } from '../context.ts';

const OK = 200;

export const routes: RouteModule = {
  'GET /v1/map/tiles/{z}/{x}/{y}': async (c, deps) => {
    principalOf(c);
    const bytes = await fetchMapTile({
      cacheDir: deps.config.dataDir,
      upstream: deps.mapTileUpstream,
      z: Number(c.req.param('z')),
      x: Number(c.req.param('x')),
      y: Number(c.req.param('y')),
    });
    // Hono takes a Uint8Array over a plain ArrayBuffer; the copy gives it one without a type cast.
    return c.body(new Uint8Array(bytes), OK, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
  },
};
