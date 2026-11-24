/**
 * OpenAPI 3.1 document for the integration contract (design sections 5, 6 and 12), built from `ROUTES` and the
 * zod schemas the service validates with. Request bodies use the `input` side of a schema, responses the `output`
 * side. `npm run openapi:generate` writes the result to openapi.yaml.
 */
import { z } from 'zod';
import { ROUTES, type RouteAuth, type RouteSpec } from '../http/routes/index.ts';
import { ERROR_STATUS, type ErrorCode } from './errors.ts';
import { ROUTE_DOCS, type RouteDoc, type SuccessDoc } from './openapi-routes.ts';
import { WORKFLOW_EXAMPLE } from './openapi-workflow.ts';
import { CONTRACT_SCHEMAS, ListChatsQuery, PlacesSearchQuery } from './schemas.ts';

type Json = Record<string, unknown>;

const OPENAPI_VERSION = '3.1.0';
const API_VERSION = '0.1.0';
const COMPONENTS = '#/components/schemas/';
const ref = (name: string): Json => ({ $ref: `${COMPONENTS}${name}` });
const JSON_TYPE = 'application/json';

/** Component schemas that describe request bodies; everything else describes a response. */
const REQUEST_SCHEMAS = [
  'EraseRequest', 'ConsentPromptRequest',
  'IngestRequest', 'IntakeEvent', 'RegisterChatRequest', 'DispatchRequest', 'DispatchByPhoneRequest', 'ControlRequest', 'DmRepliesRequest',
  'OfficerMessageRequest', 'OfficerDecisionRequest', 'CaseReferenceRequest', 'WatchlistReviewRequest', 'ScammerFlagRequest', 'CitizenReportImportRequest', 'OfficerLoginRequest',
] as const;
/** Small enums that both sides share; emitted once, from the output side. */
const SHARED_SCHEMAS = ['Source', 'Direction'] as const;

const SECURITY_SCHEMES = {
  officerToken: {
    type: 'http',
    scheme: 'bearer',
    description: 'An officer token, sent only in the Authorization header. Never put a token in a URL.',
  },
  connectorToken: {
    type: 'http',
    scheme: 'bearer',
    description: 'A connector token (intake), sent only in the Authorization header. Never put a token in a URL.',
  },
} as const;

const SECURITY: Record<RouteAuth, Json[]> = {
  officer: [{ officerToken: [] }],
  connector: [{ connectorToken: [] }],
  any: [{ officerToken: [] }, { connectorToken: [] }],
  none: [],
};

function stripIds(schema: unknown): Json {
  const { $schema: _schema, $id: _id, ...rest } = schema as Json;
  return rest;
}

/** Generates one registry's schemas with the given io mode. */
function generate(names: readonly string[], io: 'input' | 'output'): Record<string, Json> {
  const registry = z.registry<{ id: string }>();
  for (const name of names) registry.add(CONTRACT_SCHEMAS[name as keyof typeof CONTRACT_SCHEMAS], { id: name });
  const out = z.toJSONSchema(registry, { target: 'draft-2020-12', io, uri: (id) => `${COMPONENTS}${id}` });
  return Object.fromEntries(Object.entries(out.schemas).map(([name, schema]) => [name, stripIds(schema)]));
}

const LIST_META = {
  type: 'object',
  additionalProperties: false,
  required: ['total', 'limit', 'offset'],
  properties: { total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' } },
};

function componentSchemas(): Record<string, Json> {
  const all = Object.keys(CONTRACT_SCHEMAS);
  const requests: readonly string[] = [...REQUEST_SCHEMAS, ...SHARED_SCHEMAS];
  const responses = all.filter((n) => !(REQUEST_SCHEMAS as readonly string[]).includes(n));
  return { ...generate(requests, 'input'), ...generate(responses, 'output'), ListMeta: LIST_META };
}

function successEnvelope(success: SuccessDoc): Json {
  const properties: Json = {
    success: { const: true },
    data: success.schema ? ref(success.schema) : {},
    error: { type: 'null' },
  };
  if (success.paginated) properties.meta = ref('ListMeta');
  return {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'data', 'error'],
    properties,
  };
}

function statusesOf(codes: readonly ErrorCode[]): Map<number, ErrorCode[]> {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return byStatus;
}

/** Errors every route can answer, then the ones that follow from its auth and body. */
function errorCodes(spec: RouteSpec, doc: RouteDoc): ErrorCode[] {
  const common: ErrorCode[] = ['host_not_allowed', 'rate_limited', 'internal_error'];
  const auth: ErrorCode[] = spec.auth === 'none' ? [] : ['unauthenticated', 'forbidden_for_principal'];
  return [...new Set([...auth, ...doc.errors, ...common])];
}

function errorResponses(spec: RouteSpec, doc: RouteDoc): Record<string, Json> {
  const responses: Record<string, Json> = {};
  const codes = errorCodes(spec, doc);
  for (const [status, group] of [...statusesOf(codes)].sort(([a], [b]) => a - b)) {
    responses[String(status)] = {
      description: `Error envelope. \`error.code\` is one of: ${group.map((c) => `\`${c}\``).join(', ')}.`,
      content: { [JSON_TYPE]: { schema: ref('ErrorEnvelope') } },
    };
  }
  return responses;
}

const REPLAY_HEADER = {
  'Idempotency-Replayed': {
    description: 'Set to `true` when the stored response of an earlier request with the same key is replayed.',
    schema: { type: 'string', enum: ['true'] },
  },
};

const PNG_HEADERS = {
  'Cache-Control': { schema: { type: 'string', const: 'private, no-store' } },
  'X-Content-Type-Options': { schema: { type: 'string', const: 'nosniff' } },
  'Content-Disposition': { schema: { type: 'string' }, description: '`inline; filename="<artifactId>.png"`' },
  'X-Mirsad-SHA256': { schema: { type: 'string' }, description: 'Checksum of the stored file, verified on every read.' },
};

function successResponse(doc: RouteDoc, success: SuccessDoc): Json {
  const response: Json = { description: success.description };
  if (doc.kind === 'png') {
    response.headers = PNG_HEADERS;
    response.content = { 'image/png': { schema: { type: 'string', contentMediaType: 'image/png' } } };
  } else if (doc.kind === 'event-stream') {
    response.content = { 'text/event-stream': { schema: { type: 'string' } } };
  } else if (doc.kind === 'static') {
    response.content = { '*/*': { schema: { type: 'string' } } };
  } else {
    response.content = { [JSON_TYPE]: { schema: successEnvelope(success) } };
  }
  if (success.replayHeader) response.headers = REPLAY_HEADER;
  return response;
}

function pathParameters(path: string): Json[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

/** Query parameters of `GET /v1/chats`, taken from the zod query schema. */
function listChatsQuery(): Json[] {
  return zodQueryParameters(ListChatsQuery);
}

/** Query parameters of `GET /v1/places/search`, taken from the zod query schema. */
function placesSearchQuery(): Json[] {
  return zodQueryParameters(PlacesSearchQuery);
}

/** Every query parameter of a GET route, taken from its zod input schema. */
function zodQueryParameters(schema: z.ZodType): Json[] {
  const rendered = z.toJSONSchema(schema, { io: 'input' }) as { properties: Record<string, Json> };
  return Object.entries(rendered.properties).map(([name, property]) => ({ name, in: 'query', required: false, schema: property }));
}

const STREAM_PARAMETERS: Json[] = [
  {
    name: 'cursor',
    in: 'query',
    required: false,
    description: 'Decimal stream position, usually `cursor` from a timeline or chat list. Ignored when `Last-Event-ID` is sent.',
    schema: { type: 'string', pattern: '^\\d{1,15}$' },
  },
  {
    name: 'Last-Event-ID',
    in: 'header',
    required: false,
    description: 'The `id` of the last event the client saw; the stream resumes after it.',
    schema: { type: 'string', pattern: '^\\d{1,15}$' },
  },
];

const IDEMPOTENCY_PARAMETER: Json = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Scoped to principal and route (and chat). The same key with the same body replays the stored response; the same key with a different body answers `422 idempotency_key_reused`.',
  // The server's rule (src/http/middleware/idempotency.ts): 1 to 200 visible ASCII characters, no spaces.
  schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[\\x21-\\x7e]+$' },
};

function parameters(spec: RouteSpec, doc: RouteDoc): Json[] {
  return [
    ...pathParameters(documentedPath(spec.path)),
    ...(doc.listChatsQuery ? listChatsQuery() : []),
    ...(doc.placesSearchQuery ? placesSearchQuery() : []),
    ...(doc.kind === 'event-stream' ? STREAM_PARAMETERS : []),
    ...(doc.idempotencyKey ? [IDEMPOTENCY_PARAMETER] : []),
  ];
}

function operation(spec: RouteSpec, doc: RouteDoc): Json {
  const params = parameters(spec, doc);
  const op: Json = {
    operationId: operationId(spec),
    summary: doc.summary,
    tags: [spec.extension ? 'extension' : doc.kind === 'static' ? 'dashboard' : 'contract'],
    security: SECURITY[spec.auth],
  };
  if (doc.description) op.description = doc.description;
  if (params.length > 0) op.parameters = params;
  if (doc.request) {
    op.requestBody = { required: true, content: { [JSON_TYPE]: { schema: ref(doc.request) } } };
  }
  const responses: Record<string, Json> = {};
  for (const success of doc.success) responses[String(success.status)] = successResponse(doc, success);
  op.responses = { ...responses, ...errorResponses(spec, doc) };
  return op;
}

function operationId(spec: RouteSpec): string {
  const words = spec.path.split('/').filter(Boolean).map((part) => part.replace(/[{}*]/g, '') || 'asset');
  const camel = words.map((w, i) => (i === 0 ? w : w[0]?.toUpperCase() + w.slice(1))).join('');
  return `${spec.method.toLowerCase()}_${camel || 'root'}`;
}

/** Documented path: `/assets/*` becomes `/assets/{assetPath}`. */
const documentedPath = (path: string): string => path.replace('/*', '/{assetPath}');

function paths(): Record<string, Json> {
  const result: Record<string, Json> = {};
  for (const spec of ROUTES) {
    const doc = ROUTE_DOCS[`${spec.method} ${spec.path}`];
    if (!doc) throw new Error(`openapi: route without documentation: ${spec.method} ${spec.path}`);
    const key = documentedPath(spec.path);
    result[key] = { ...result[key], [spec.method.toLowerCase()]: operation(spec, doc) };
  }
  return result;
}

export function buildOpenApiDocument(): object {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Mirsad integration API',
      version: API_VERSION,
      description:
        'Register conversations, submit intake events, control AI review and read timelines. Every JSON response uses the envelope `{ success, data, error }`; the artifact route (PNG) and the event stream (SSE) are the two exceptions. Everything here is served on a loopback address only.',
    },
    servers: [{ url: 'http://127.0.0.1:8787', description: 'Default local address; the port is configurable.' }],
    tags: [
      { name: 'contract', description: 'Routes of the integration contract.' },
      { name: 'extension', description: 'Routes beyond the integration contract table; each exists because a requirement cannot be met without it.' },
      { name: 'dashboard', description: 'Static files of the reference dashboard.' },
    ],
    security: [],
    paths: paths(),
    components: { securitySchemes: SECURITY_SCHEMES, schemas: componentSchemas() },
    'x-workflow-example': WORKFLOW_EXAMPLE,
  };
}
