/**
 * Map tile proxy backing the officer places map. Tiles come from the upstream
 * raster provider but the browser only ever talks to us, so the dashboard's
 * strict same-origin Content-Security-Policy is untouched. Tiles are cached
 * on disk under the data directory: one upstream fetch serves every officer.
 *
 * The upstream host is a server constant, never request input: there is no
 * server-side request forgery. Coordinates are range-checked before they touch
 * the URL or the cache path, so there is no traversal. Only responses that
 * look like PNGs under the size cap are cached.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../contract/errors.ts';

export const MAP_TILE_MAX_ZOOM = 19;
/** Largest tile body we cache: real OSM PNGs are tens of kilobytes. */
export const MAP_TILE_MAX_BYTES = 2 * 1024 * 1024;
/** First bytes of a PNG file: checked before anything is cached or served from upstream. */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Disk-cached tiles are capped so one account cannot fill the disk by crawling. */
const MAP_TILE_CACHE_MAX_FILES = 2000;
const UPSTREAM_TIMEOUT_MS = 10_000;

export interface MapTileRequest {
  cacheDir: string;
  /** Base URL of the raster provider, e.g. https://tile.openstreetmap.org. Tests pass a local stub. */
  upstream: string;
  z: number;
  x: number;
  y: number;
  fetchFn?: typeof fetch;
}

function tilePath(cacheDir: string, z: number, x: number, y: number): string {
  return path.join(cacheDir, 'map-tiles', String(z), String(x), `${y}.png`);
}

function invalid(): AppError {
  return AppError.of('validation_failed', 'Tile coordinates must satisfy 0 <= zoom <= 19 and 0 <= x,y < 2^zoom.', {
    fields: [{ path: 'z/x/y', message: 'Expected integer tile coordinates inside the zoom range.' }],
  });
}

export function validateTile(z: number, x: number, y: number): void {
  if (![z, x, y].every((n) => Number.isInteger(n)) || z < 0 || z > MAP_TILE_MAX_ZOOM) throw invalid();
  const edge = 2 ** z;
  if (x < 0 || y < 0 || x >= edge || y >= edge) throw invalid();
}

/** In-flight upstream fetches, keyed by tile: concurrent misses for one tile share a single request. */
const inflight = new Map<string, Promise<Uint8Array>>();

/** PNG bytes for one tile, from disk cache or from upstream on a miss. */
export async function fetchMapTile(request: MapTileRequest): Promise<Uint8Array> {
  const { cacheDir, upstream, z, x, y } = request;
  validateTile(z, x, y);
  const file = tilePath(cacheDir, z, x, y);
  try {
    const cached = new Uint8Array(await fs.promises.readFile(file));
    if (isPng(cached)) return cached;
  } catch {
    // Cache miss or a foreign file in the cache slot: fall through to upstream.
  }
  const key = `${z}/${x}/${y}`;
  const running = inflight.get(key);
  if (running) return running;
  const pending = loadUpstream(request, file).finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

async function loadUpstream(request: MapTileRequest, file: string): Promise<Uint8Array> {
  const { cacheDir, upstream, z, x, y } = request;
  const fetchFn = request.fetchFn ?? fetch;
  const response = await fetchFn(`${upstream.replace(/\/+$/, '')}/${z}/${x}/${y}.png`, {
    headers: { 'User-Agent': 'Mirsad/0.1.0 (officer places map; contact: local operator)' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw AppError.of('internal_error', 'The map tile provider did not answer.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAP_TILE_MAX_BYTES || !isPng(bytes)) {
    throw AppError.of('internal_error', 'The map tile provider sent an unusable tile.');
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await evictOldest(cacheDir);
  await fs.promises.writeFile(file, bytes);
  return bytes;
}

/** Keeps the on-disk tile cache bounded by deleting the oldest tiles first. */
async function evictOldest(cacheDir: string): Promise<void> {
  const root = path.join(cacheDir, 'map-tiles');
  let entries: string[] = [];
  try {
    entries = await collectTiles(root);
  } catch {
    return;
  }
  const overflow = entries.length - MAP_TILE_CACHE_MAX_FILES;
  if (overflow <= 0) return;
  const withTime = await Promise.all(
    entries.map(async (file) => ({ file, mtime: (await fs.promises.stat(file).catch(() => null))?.mtimeMs ?? 0 })),
  );
  withTime.sort((a, b) => a.mtime - b.mtime);
  await Promise.all(withTime.slice(0, overflow).map(({ file }) => fs.promises.rm(file, { force: true })));
}

async function collectTiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectTiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
