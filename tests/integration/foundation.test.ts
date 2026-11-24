import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { Hono } from 'hono';
import { startHarness, type TestHarness } from '../helpers/harness.ts';
import type { AppDeps } from '../../src/app.ts';
import { notImplemented, type AppEnv } from '../../src/http/context.ts';
import { errorHandler } from '../../src/http/middleware/error-handler.ts';
import { createJsonLogger } from '../../src/logging/json-logger.ts';
import { ROUTES } from '../../src/http/routes/index.ts';
import { hashToken } from '../../src/identity/tokens.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

function expectErrorEnvelope(body: unknown, code: string) {
  expect(body).toEqual({
    success: false,
    data: null,
    error: expect.objectContaining({ code, message: expect.any(String) }),
  });
}

function rawGet(port: number, hostHeader: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/healthz', method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('foundation', () => {
  it('healthz answers without a token', async () => {
    const res = await h.http(null).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: 'ok' }, error: null });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a missing or unknown token is 401 unauthenticated in the standard envelope', async () => {
    const missing = await h.http(null).get('/v1/me');
    expect(missing.status).toBe(401);
    expectErrorEnvelope(missing.body, 'unauthenticated');
    const unknown = await h.http('not-a-real-token').post('/v1/ingest', {});
    expect(unknown.status).toBe(401);
    expectErrorEnvelope(unknown.body, 'unauthenticated');
  });

  it('a connector token on an officer route and an officer token on an intake route are 403 forbidden_for_principal', async () => {
    const connectorOnOfficer = await h.http(h.tokens.connector).get('/v1/chats');
    expect(connectorOnOfficer.status).toBe(403);
    expectErrorEnvelope(connectorOnOfficer.body, 'forbidden_for_principal');
    const officerOnIntake = await h.http(h.tokens.officerA).post('/v1/ingest', {});
    expect(officerOnIntake.status).toBe(403);
    expectErrorEnvelope(officerOnIntake.body, 'forbidden_for_principal');
    const officerOnEvents = await h.http(h.tokens.officerA).post('/v1/chats/chat_x/events', {});
    expect(officerOnEvents.status).toBe(403);
  });

  it('GET /v1/me returns the calling principal for officers and connectors', async () => {
    const officer = await h.http(h.tokens.officerA).get('/v1/me');
    expect(officer.status).toBe(200);
    expect(officer.body).toEqual({
      success: true,
      data: {
        principal: {
          id: expect.stringMatching(/^prn_[0-9a-f]{32}$/),
          kind: 'officer',
          displayName: 'Officer A',
          workspaceId: expect.stringMatching(/^ws_[0-9a-f]{32}$/),
        },
      },
      error: null,
    });
    const connector = await h.http(h.tokens.connector).get('/v1/me');
    expect(connector.body.data.principal).toMatchObject({ kind: 'connector', displayName: 'Fixture Connector' });
    expect(connector.body.data.principal.workspaceId).toBe(officer.body.data.principal.workspaceId);
    const outsider = await h.http(h.tokens.outsider).get('/v1/me');
    expect(outsider.body.data.principal.workspaceId).not.toBe(officer.body.data.principal.workspaceId);
  });

  it('a non-loopback Host header is 403 host_not_allowed', async () => {
    const port = Number(new URL(h.baseUrl).port);
    const foreign = await rawGet(port, `mirsad.example.test:${port}`);
    expect(foreign.status).toBe(403);
    expectErrorEnvelope(foreign.body, 'host_not_allowed');
    const wrongPort = await rawGet(port, `127.0.0.1:${port + 1}`);
    expect(wrongPort.status).toBe(403);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await rawGet(port, host)).status).toBe(200);
    }
  });

  it('a body over 256 KiB is 413 payload_too_large', async () => {
    const big = { padding: 'x'.repeat(256 * 1024 + 1) };
    const res = await h.http(h.tokens.officerA).post('/v1/chats', big);
    expect(res.status).toBe(413);
    expectErrorEnvelope(res.body, 'payload_too_large');
  });

  it('an intake body of 300 KiB passes the size limit and one above 1 MiB is 413', async () => {
    const connector = h.http(h.tokens.connector);
    const medium = { padding: 'x'.repeat(300 * 1024) };
    // Past the size limit, the padded body reaches validation (400) instead of being refused as too large (413).
    expect((await connector.post('/v1/ingest', medium)).status).toBe(400);
    expect((await connector.post('/v1/chats/chat_1/events', medium)).status).toBe(400);
    const huge = { padding: 'x'.repeat(1024 * 1024 + 1) };
    for (const intakePath of ['/v1/ingest', '/v1/chats/chat_1/events']) {
      const res = await connector.post(intakePath, huge);
      expect(res.status, intakePath).toBe(413);
      expectErrorEnvelope(res.body, 'payload_too_large');
    }
  });

  it('a token in the query string does not authenticate', async () => {
    const token = encodeURIComponent(h.tokens.officerA);
    for (const query of [`token=${token}`, `access_token=${token}`, `authorization=Bearer%20${token}`]) {
      const res = await h.http(null).get(`/v1/me?${query}`);
      expect(res.status, query).toBe(401);
      expectErrorEnvelope(res.body, 'unauthenticated');
    }
  });

  it('a disabled principal is 401', async () => {
    const client = h.http(h.tokens.officerC);
    expect((await client.get('/v1/me')).status).toBe(200);
    const db = openDatabase(path.join(h.dataDir, DATABASE_FILE));
    try {
      db.transaction((tx) =>
        tx.run('UPDATE principals SET disabled = 1 WHERE token_sha256 = :hash', { hash: hashToken(h.tokens.officerC) }),
      );
    } finally {
      db.close();
    }
    const res = await client.get('/v1/me');
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'unauthenticated');
  });

  it('an unimplemented route answers 501 not_implemented in the envelope', async () => {
    // Exercises the shared stub handler directly, so the test does not depend on which routes are still stubs.
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(createJsonLogger({ write: () => {} })));
    app.get('/stub', (c) => notImplemented(c, {} as AppDeps));
    const res = await app.request('/stub');
    expect(res.status).toBe(501);
    expectErrorEnvelope(await res.json(), 'not_implemented');
    const unknown = await h.http(h.tokens.officerA).get('/v1/nothing-here');
    expect(unknown.status).toBe(404);
    expectErrorEnvelope(unknown.body, 'not_found');
  });

  it('every route of the contract is registered with its access rule', async () => {
    expect(ROUTES).toHaveLength(36);
    for (const route of ROUTES.filter((r) => r.auth !== 'none')) {
      const path = route.path.replace(/\{[^}]+\}/g, 'x_1');
      const res = route.method === 'GET' ? await h.http(null).get(path) : await h.http(null).post(path, {});
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
    }
  });
});

describe('harness', () => {
  it('drains idle workers, captures logs in memory and restarts on the same data directory', async () => {
    const local = await startHarness();
    try {
      await local.drain();
      const before = await local.http(local.tokens.officerA).get('/v1/me');
      const firstUrl = local.baseUrl;
      await local.restart();
      expect(local.baseUrl).toBe(firstUrl);
      const after = await local.http(local.tokens.officerA).get('/v1/me');
      expect(after.body.data.principal.id).toBe(before.body.data.principal.id);
      expect(local.logs.some((line) => JSON.parse(line).event === 'server_listening')).toBe(true);
      for (const token of Object.values(local.tokens)) {
        expect(local.logs.join('\n')).not.toContain(token);
      }
    } finally {
      await local.close();
    }
  });

  it('restart() returns only once the new server answers, so a socket the old server closed never fails a test request', async () => {
    const local = await startHarness();
    const realFetch = globalThis.fetch;
    let staleSockets = 0;
    // A request sent on a keep-alive socket the old server closed fails once with ECONNRESET (seen once after a restart).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (staleSockets === 0) return realFetch(input, init);
      staleSockets -= 1;
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    });
    try {
      staleSockets = 1;
      await local.restart();
      const after = await local.http(local.tokens.officerA).get('/v1/me');
      expect(after.status).toBe(200);
      expect(staleSockets).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      await local.close();
    }
  });
});

describe('rate limit', () => {
  let limited: TestHarness;
  beforeAll(async () => {
    limited = await startHarness({ config: { rateLimitPerMinute: 3 } });
  });
  afterAll(async () => {
    await limited.close();
  });

  it('more requests than the per-minute limit are 429 rate_limited', async () => {
    const client = limited.http(limited.tokens.officerA);
    for (let i = 0; i < 3; i += 1) expect((await client.get('/v1/me')).status).toBe(200);
    const blocked = await client.get('/v1/me');
    expect(blocked.status).toBe(429);
    expectErrorEnvelope(blocked.body, 'rate_limited');
    expect((await limited.http(limited.tokens.officerB).get('/v1/me')).status).toBe(200);
    limited.clock.advance(60_000);
    expect((await client.get('/v1/me')).status).toBe(200);
  });
});
