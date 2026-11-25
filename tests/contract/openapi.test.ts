import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CONTACT_SYNC_LABELS } from '../../src/contract/labels.ts';
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
      // The path really sent is the documented template with the real chat id filled in.
      expect(sent?.path).toBe(step.path.replace('{chatId}', realChatId));
      // Stable response fields must match what the service really returned, so the example cannot drift.
      const documented = withDocumentedId(step.response.body) as { data: Record<string, any> };
      const live = withDocumentedId(sent?.response.body) as { data: Record<string, any> };
      for (const field of STABLE_RESPONSE_FIELDS) {
        const expectedValue = pick(documented.data, field);
        if (expectedValue === undefined) continue;
        expect(pick(live.data, field), `${step.name} ${field}`).toEqual(expectedValue);
      }
      if (step.name !== 'fetch_timeline') return;
      // Positions are one order across messages and case actions: the documented timeline shows the order the service
      // produced, uses no position twice and has a cursor no lower than any position it shows.
      const shown = timelineEntries(documented.data as TimelineData);
      expect(shown.map(([name]) => name)).toEqual(timelineEntries(live.data as TimelineData).map(([name]) => name));
      const positions = shown.map(([, position]) => position);
      expect(new Set(positions).size).toBe(positions.length);
      expect(Number(documented.data.cursor)).toBeGreaterThanOrEqual(Math.max(...positions));
    });
  });

  it('the documented Idempotency-Key schema accepts exactly the keys the server accepts', async () => {
    const doc = asJson(buildOpenApiDocument()) as { paths: Record<string, Record<string, any>> };
    const parameter = (doc.paths['/v1/dispatches']?.post?.parameters as { name: string; schema: object }[]).find((p) => p.name === 'Idempotency-Key');
    const documentedAccepts = new Ajv2020({ strict: true }).compile(parameter?.schema ?? {});
    for (const key of ['dispatch-key-1', 'x'.repeat(200), 'x'.repeat(201), 'with space', 'tab\there', '~!#$%&*+.^_|']) {
      // A chat that does not exist: a key the server accepts gets past the header check to 404 chat_not_found.
      const res = await h.http(h.tokens.officerA).post('/v1/dispatches', { chatIds: ['chat_00000000000000000000000000000000'] }, { 'Idempotency-Key': key });
      const serverAccepts = res.body?.error?.code !== 'idempotency_key_required';
      expect(documentedAccepts(key), JSON.stringify(key)).toBe(serverAccepts);
    }
  });

  it('evidence_access_required is documented only on the route that raises it, the watchlist review', () => {
    const doc = asJson(buildOpenApiDocument()) as { paths: Record<string, Record<string, any>> };
    const documentedOn = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, operation]) => Object.values(operation.responses ?? {}).some((r: any) => String(r.description).includes('`evidence_access_required`')))
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(documentedOn).toEqual(['POST /v1/watchlist/{entryId}/review']);
  });

  it('a watchlist entry documents its contact-sync state with the exact labels', () => {
    const doc = asJson(buildOpenApiDocument()) as { components: { schemas: Record<string, any> } };
    const contactSync = doc.components.schemas.WatchlistEntry.properties.contactSync;
    expect(doc.components.schemas.WatchlistEntry.required).toContain('contactSync');
    expect(contactSync.anyOf.map((s: { type: string }) => s.type)).toEqual(['object', 'null']);
    expect(contactSync.anyOf[0].properties.label.enum).toEqual(Object.values(CONTACT_SYNC_LABELS));
  });

  it('no documented route lists not_implemented, because every route is implemented', () => {
    const doc = asJson(buildOpenApiDocument()) as { paths: Record<string, Record<string, any>> };
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        expect(Object.keys(operation.responses ?? {}), `${method} ${path}`).not.toContain('501');
      }
    }
  });
});

const STABLE_RESPONSE_FIELDS = [
  'chat.inboxStatus',
  'chat.aiMode',
  'chat.revision',
  'result',
  'results.0.status',
  'messages.0.sender',
] as const;

interface TimelineData {
  caseActions: { type: string; position: number }[];
  messages: { position: number }[];
  cursor: string;
}

/** A timeline's case actions (by type) and messages (as 'message') with their positions, in position order. */
function timelineEntries(timeline: TimelineData): Array<[string, number]> {
  return [
    ...timeline.caseActions.map((action): [string, number] => [action.type, action.position]),
    ...timeline.messages.map((message): [string, number] => ['message', message.position]),
  ].sort(([, a], [, b]) => a - b);
}

function pick(value: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value);
}
