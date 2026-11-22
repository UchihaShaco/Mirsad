import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildOpenApiDocument } from '../../src/contract/openapi.ts';
import { ROUTES } from '../../src/http/routes/index.ts';
import { runExample } from '../../examples/headless-client/run.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const OPENAPI_FILE = path.resolve(import.meta.dirname, '../../openapi.yaml');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface WorkflowStep {
  name: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  requestBody?: unknown;
  response: { status: number; body: unknown };
}

const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
/** `/assets/*` is documented as `/assets/{assetPath}`. */
const documentedPath = (routePath: string): string => routePath.replace('/*', '/{assetPath}');

function documentedOperations(doc: { paths: Record<string, Record<string, unknown>> }): string[] {
  return Object.entries(doc.paths).flatMap(([p, item]) =>
    HTTP_METHODS.filter((m) => m in item).map((m) => `${m.toUpperCase()} ${p}`),
  );
}

describe('openapi.yaml', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('openapi.yaml matches the generator output', () => {
    const onDisk = parse(fs.readFileSync(OPENAPI_FILE, 'utf8'));
    expect(onDisk).toEqual(asJson(buildOpenApiDocument()));
  });

  it('every server route is documented and every documented route exists', async () => {
    const doc = asJson(buildOpenApiDocument()) as { paths: Record<string, Record<string, unknown>> };
    const documented = documentedOperations(doc).sort();
    const served = ROUTES.map((r) => `${r.method} ${documentedPath(r.path)}`).sort();
    expect(documented).toEqual(served);

    // The live service answers every documented route (401 without a token, or the route's own answer),
    // and answers an undocumented path with the 404 not_found of the router.
    for (const route of ROUTES) {
      const concrete = route.path.replace(/\{[^}]+\}/g, 'x').replace('*', 'styles.css');
      const res = await h.http(null)[route.method === 'GET' ? 'get' : 'post'](concrete);
      expect(res.body?.error?.code, `${route.method} ${route.path}`).not.toBe('not_found');
    }
    const unknown = await h.http(null).get('/v1/not-a-route');
    expect(unknown.status).toBe(404);
  });

  it('the workflow example lists the payloads the headless client sends', async () => {
    const doc = asJson(buildOpenApiDocument()) as Record<string, unknown>;
    const steps = doc['x-workflow-example'] as WorkflowStep[];
    expect(steps.map((s) => s.name)).toEqual(['register_chat', 'dispatch', 'submit_inbound_event', 'fetch_timeline', 'take_over']);

    const externalAccountId = h.accounts.officer.externalAccountId;
    const trace = await runExample({
      baseUrl: h.baseUrl,
      officerToken: h.tokens.officerA,
      connectorToken: h.tokens.connector,
      externalAccountId,
    });
    expect(trace.exchanges).toHaveLength(steps.length);

    // IDs are issued by the service; the document shows one example ID, so map the real one onto it.
    const documentedChatId = (steps[1]?.requestBody as { chatIds: string[] }).chatIds[0] ?? '';
    const realChatId = (trace.exchanges[0]?.response.body as { data: { chat: { id: string } } }).data.chat.id;
    const withDocumentedId = (value: unknown): unknown =>
      value === undefined ? undefined : JSON.parse(JSON.stringify(value).replaceAll(realChatId, documentedChatId));

    steps.forEach((step, i) => {
      const sent = trace.exchanges[i];
      expect(sent?.name).toBe(step.name);
      expect(sent?.method).toBe(step.method);
      expect(sent?.pathTemplate).toBe(step.path);
      // The account is host specific; every other byte of each request body is as documented.
      const expectedBody =
        step.name === 'register_chat' ? { ...(step.requestBody as object), externalAccountId } : step.requestBody;
      expect(withDocumentedId(sent?.requestBody)).toEqual(expectedBody);
      expect(sent?.response.status).toBe(step.response.status);
      for (const header of Object.keys(step.headers)) {
        expect(sent?.requestHeaders, header).toHaveProperty([header.toLowerCase()]);
      }
    });
  });
});
