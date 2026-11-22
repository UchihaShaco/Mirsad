import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runExample, type ExampleTrace } from '../../examples/headless-client/run.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const OPENAPI_FILE = path.resolve(import.meta.dirname, '../../openapi.yaml');
const addFormats = formatsPlugin.default;

type Schema = Record<string, unknown>;
interface Operation {
  requestBody?: { content: { 'application/json': { schema: Schema } } };
  responses: Record<string, { content?: { 'application/json'?: { schema: Schema } } }>;
}

interface ExampleStep {
  name: string;
  method: string;
  path: string;
  response: { status: number; body: unknown };
}

let h: TestHarness;
let trace: ExampleTrace;

/** The schema openapi.yaml documents for `what`. A missing one fails the test: ajv accepts anything for an empty schema. */
function documented(schema: Schema | undefined, what: string): Schema {
  expect(schema, `openapi.yaml documents ${what}`).toBeDefined();
  return schema as Schema;
}

beforeAll(async () => {
  h = await startHarness();
  trace = await runExample({
    baseUrl: h.baseUrl,
    officerToken: h.tokens.officerA,
    connectorToken: h.tokens.connector,
    externalAccountId: h.accounts.officer.externalAccountId,
  });
});
afterAll(async () => {
  await h.close();
});

describe('step 3: headless example client', () => {
  it('the headless example completes against a running service using only HTTP', async () => {
    expect(trace.exchanges.map((e) => [e.name, e.response.status])).toEqual([
      ['register_chat', 201],
      ['dispatch', 200],
      ['submit_inbound_event', 201],
      ['fetch_timeline', 200],
      ['take_over', 200],
    ]);
    const chatId = (trace.exchanges[0]?.response.body as { data: { chat: { id: string } } }).data.chat.id;
    const timeline = trace.exchanges[3]?.response.body as {
      data: { chat: { id: string }; messages: { direction: string }[] };
    };
    expect(timeline.data.chat.id).toBe(chatId);
    expect(timeline.data.messages.map((m) => m.direction)).toEqual(['incoming']);

    // The service agrees: the chat is now under officer control.
    await h.drain();
    const after = await h.http(h.tokens.officerA).get(`/v1/chats/${chatId}/timeline`);
    expect(after.body.data.chat.aiMode).toBe('officer_control');
  });

  it('every request and response it exchanged validates against openapi.yaml', async () => {
    const doc = (await $RefParser.dereference(parse(fs.readFileSync(OPENAPI_FILE, 'utf8')))) as unknown as {
      paths: Record<string, Record<string, Operation>>;
    };
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
    addFormats(ajv);
    expect(trace.exchanges.length).toBeGreaterThan(0);
    for (const exchange of trace.exchanges) {
      const operation = doc.paths[exchange.pathTemplate]?.[exchange.method.toLowerCase()];
      expect(operation, `${exchange.method} ${exchange.pathTemplate} is documented`).toBeDefined();
      if (exchange.requestBody !== undefined) {
        const schema = documented(operation?.requestBody?.content['application/json'].schema, `the ${exchange.name} request`);
        const validate = ajv.compile(schema);
        expect(validate(exchange.requestBody), `${exchange.name} request: ${ajv.errorsText(validate.errors)}`).toBe(true);
      }
      const responseSchema = documented(
        operation?.responses[String(exchange.response.status)]?.content?.['application/json']?.schema,
        `the ${exchange.name} response with status ${exchange.response.status}`,
      );
      const validate = ajv.compile(responseSchema);
      expect(validate(exchange.response.body), `${exchange.name} response: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it('the representative responses in the workflow example validate against their own schemas', async () => {
    const raw = parse(fs.readFileSync(OPENAPI_FILE, 'utf8')) as { 'x-workflow-example': ExampleStep[] };
    const doc = (await $RefParser.dereference(raw)) as unknown as {
      paths: Record<string, Record<string, Operation>>;
      'x-workflow-example': ExampleStep[];
    };
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
    addFormats(ajv);
    for (const step of doc['x-workflow-example']) {
      const schema = documented(
        doc.paths[step.path]?.[step.method.toLowerCase()]?.responses[String(step.response.status)]?.content?.['application/json']?.schema,
        `the ${step.name} response with status ${step.response.status}`,
      );
      const validate = ajv.compile(schema);
      expect(validate(step.response.body), `${step.name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });
});
