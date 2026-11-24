/** Map tile proxy: officer auth, upstream fetch with disk cache, coordinate validation. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const TINY_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
let upstream: http.Server;
let upstreamPort = 0;
let hits = 0;
let h: TestHarness;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(TINY_PNG);
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  upstreamPort = (upstream.address() as AddressInfo).port;
  h = await startHarness({ mapTileUpstream: `http://127.0.0.1:${upstreamPort}` });
});

afterAll(async () => {
  await h.close();
  await new Promise<void>((done) => upstream.close(() => done()));
});

async function tile(z: number, x: number, y: number, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`${h.baseUrl}/v1/map/tiles/${z}/${x}/${y}`, { headers });
}

describe('map tile proxy', () => {
  it('proxies one tile and serves the repeat from disk cache', async () => {
    const first = await tile(10, 512, 512, h.tokens.officerA);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await first.arrayBuffer())).toEqual(TINY_PNG);
    expect(hits).toBe(1);

    const second = await tile(10, 512, 512, h.tokens.officerA);
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(TINY_PNG);
    expect(hits).toBe(1);
  });

  it('rejects coordinates outside the zoom range', async () => {
    const res = await h.http(h.tokens.officerA).get('/v1/map/tiles/99/0/0');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('rejects non-numeric tile coordinates', async () => {
    const res = await h.http(h.tokens.officerA).get('/v1/map/tiles/abc/def/ghi');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('refuses anonymous callers', async () => {
    const res = await tile(10, 512, 512, null);
    expect(res.status).toBe(401);
  });
});
