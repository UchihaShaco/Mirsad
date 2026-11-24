/** Map tile proxy: coordinate validation and disk caching without touching the network. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchMapTile } from '../../src/services/map-tiles.ts';

const DIRS: string[] = [];
afterEach(() => {
  for (const dir of DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-tiles-'));
  DIRS.push(dir);
  return dir;
}

const TINY_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function stubFetch(calls: { count: number }, bytes: Uint8Array = TINY_PNG, status = 200): typeof fetch {
  return (async () => {
    calls.count += 1;
    return new Response(bytes, { status, headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof fetch;
}

describe('map tile proxy', () => {
  it('rejects coordinates outside the zoom range', async () => {
    const cacheDir = tempDir();
    for (const [z, x, y] of [[-1, 0, 0], [20, 0, 0], [1, 2, 0], [1, 0, 2], [2.5, 0, 0]] as const) {
      await expect(fetchMapTile({ cacheDir, upstream: 'http://127.0.0.1:1', z, x, y })).rejects.toThrow();
    }
  });

  it('serves the second request from disk without calling upstream again', async () => {
    const cacheDir = tempDir();
    const calls = { count: 0 };
    const first = await fetchMapTile({ cacheDir, upstream: 'http://127.0.0.1:1', z: 10, x: 512, y: 512, fetchFn: stubFetch(calls) });
    expect(first).toEqual(TINY_PNG);
    expect(calls.count).toBe(1);
    const second = await fetchMapTile({ cacheDir, upstream: 'http://127.0.0.1:1', z: 10, x: 512, y: 512, fetchFn: stubFetch(calls) });
    expect(second).toEqual(TINY_PNG);
    expect(calls.count).toBe(1);
  });

  it('fails loudly when upstream fails', async () => {
    const cacheDir = tempDir();
    const calls = { count: 0 };
    await expect(
      fetchMapTile({ cacheDir, upstream: 'http://127.0.0.1:1', z: 5, x: 3, y: 4, fetchFn: stubFetch(calls, TINY_PNG, 500) }),
    ).rejects.toThrow();
    expect(calls.count).toBe(1);
  });

  it('refuses a non-PNG answer without caching it', async () => {
    const cacheDir = tempDir();
    const calls = { count: 0 };
    const fake = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await expect(
      fetchMapTile({ cacheDir, upstream: 'http://127.0.0.1:1', z: 6, x: 7, y: 8, fetchFn: stubFetch(calls, fake) }),
    ).rejects.toThrow();
    expect(calls.count).toBe(1);
  });

  it('shares one upstream fetch between concurrent misses', async () => {
    const cacheDir = tempDir();
    let calls = 0;
    let release!: (bytes: Uint8Array) => void;
    const gate = new Promise<Uint8Array>((done) => {
      release = done;
    });
    const fetchFn = (async () => {
      calls += 1;
      const bytes = await gate;
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const first = fetchMapTile({ cacheDir, upstream: 'http://127.0.0.1:1', z: 7, x: 8, y: 9, fetchFn });
    const second = fetchMapTile({ cacheDir, upstream: 'http://127.0.0.1:1', z: 7, x: 8, y: 9, fetchFn });
    release(TINY_PNG);
    await expect(first).resolves.toEqual(TINY_PNG);
    await expect(second).resolves.toEqual(TINY_PNG);
    expect(calls).toBe(1);
  });
});
