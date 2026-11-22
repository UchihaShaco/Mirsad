/**
 * The Mirsad HTTP API as the dashboard uses it (design sections 5 and 6). The token travels only in the Authorization
 * header. JSON envelopes are unwrapped; a failure envelope becomes an ApiError carrying the code and status.
 */

const JSON_TYPE = 'application/json';
const UNAUTHORIZED = 401;
const CHAT_LIST_LIMIT = 500;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

async function readEnvelope(response) {
  if (!(response.headers.get('content-type') ?? '').includes(JSON_TYPE)) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function toError(response, envelope) {
  const error = envelope !== null && typeof envelope.error === 'object' ? envelope.error : null;
  if (error === null) return new ApiError(response.status, 'http_error', `The service answered ${response.status}.`, null);
  return new ApiError(response.status, error.code, error.message, error.details);
}

/** Authenticated requests; a 401 is reported to onUnauthenticated before the error is thrown. */
function createTransport(token, onUnauthenticated) {
  const headersWith = (extra) => ({ ...extra, Authorization: `Bearer ${token}` });
  async function fail(response) {
    const error = toError(response, await readEnvelope(response));
    if (response.status === UNAUTHORIZED) onUnauthenticated(error);
    throw error;
  }
  return {
    async call(method, path, { body, headers } = {}) {
      const init = { method, headers: headersWith({ Accept: JSON_TYPE, ...headers }), cache: 'no-store' };
      if (body !== undefined) {
        init.headers['Content-Type'] = JSON_TYPE;
        init.body = JSON.stringify(body);
      }
      const response = await fetch(path, init);
      if (!response.ok) return fail(response);
      const envelope = await readEnvelope(response);
      if (envelope === null || envelope.success !== true) throw toError(response, envelope);
      return { data: envelope.data, meta: envelope.meta ?? null };
    },
    async blob(path) {
      const response = await fetch(path, { headers: headersWith({ Accept: 'image/png' }), cache: 'no-store' });
      if (!response.ok) return fail(response);
      return response.blob();
    },
  };
}

const segment = (value) => encodeURIComponent(value);
const chatPath = (chatId, rest) => `/v1/chats/${segment(chatId)}${rest}`;

export function createApi(token, { onUnauthenticated }) {
  const { call, blob } = createTransport(token, onUnauthenticated);
  const post = async (path, body, headers) => (await call('POST', path, { body, headers })).data;
  return {
    me: async () => (await call('GET', '/v1/me')).data.principal,
    listChats: async () => {
      const { data, meta } = await call('GET', `/v1/chats?limit=${CHAT_LIST_LIMIT}`);
      return { chats: data.chats, cursor: data.cursor, total: meta === null ? data.chats.length : meta.total };
    },
    timeline: async (chatId) => (await call('GET', chatPath(chatId, '/timeline'))).data,
    dispatch: (chatIds, idempotencyKey) => post('/v1/dispatches', { chatIds }, { 'Idempotency-Key': idempotencyKey }),
    control: (chatId, action, expectedRevision) => post(chatPath(chatId, '/control'), { action, expectedRevision }),
    sendOfficerMessage: ({ chatId, text, expectedRevision, idempotencyKey }) =>
      post(chatPath(chatId, '/officer-messages'), { text, expectedRevision }, { 'Idempotency-Key': idempotencyKey }),
    leaveUnanswered: (chatId, messageId, expectedRevision) =>
      post(chatPath(chatId, '/officer-decisions'), { decision: 'leave_unanswered', messageId, expectedRevision }),
    retryCapture: (captureId) => post(`/v1/captures/${segment(captureId)}/retry`),
    /** `request`: { kind, paymentHosts, sourceNote } (state/case-reference.js builds it). */
    recordCaseReference: (chatId, request) => post(chatPath(chatId, '/case-references'), request),
    watchlist: async () => (await call('GET', '/v1/watchlist')).data,
    reviewWatchlistEntry: (entryId, decision, reason, expectedRevision) =>
      post(`/v1/watchlist/${segment(entryId)}/review`, { decision, reason, expectedRevision }),
    /** The capture PNG; the caller turns it into an object URL. */
    artifactBlob: (artifactId) => blob(`/v1/artifacts/${segment(artifactId)}`),
  };
}
