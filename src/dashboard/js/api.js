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
function createTransport(token, onUnauthenticated = () => {}) {
  const headersWith = (extra) => token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
  async function fail(response) {
    const error = toError(response, await readEnvelope(response));
    if (response.status === UNAUTHORIZED) onUnauthenticated(error);
    throw error;
  }
  return {
    async call(method, path, { body, headers } = {}) {
      const init = { method, headers: headersWith({ Accept: JSON_TYPE, ...headers }), cache: 'no-store', redirect: 'error' };
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
const erasePath = (chatId, action) => chatId === null ? `/v1/inbox/${action}` : chatPath(chatId, '/' + action);

export async function loginOfficer({ username, password, newPassword }) {
  const { data } = await createTransport(null).call('POST', '/v1/auth/login', { body: { username, password, newPassword } });
  if (data?.passwordChangeRequired === true) return data;
  if (typeof data?.token !== 'string' || !data.token.startsWith('session_')) throw new Error('Invalid sign-in response.');
  return data;
}

export async function logoutOfficer(token) {
  if (token?.startsWith('session_')) await createTransport(token).call('POST', '/v1/auth/logout');
}

export function createApi(token, { onUnauthenticated }) {
  const { call, blob } = createTransport(token, onUnauthenticated);
  const post = async (path, body, headers) => (await call('POST', path, { body, headers })).data;
  return {
    me: async () => (await call('GET', '/v1/me')).data.principal,
    dmReplies: async () => (await call('GET', '/v1/telegram/dm-replies')).data,
    setDmReplies: (enabled) => post('/v1/telegram/dm-replies', { enabled }),
    consentPrompt: async () => (await call('GET', '/v1/telegram/consent-prompt')).data,
    // Switching Test mode off in Settings selects manual dispatch with invitations suppressed.
    setConsentPrompt: (enabled) => post('/v1/telegram/consent-prompt', enabled ? { enabled, manualDispatchOnly: true } : { enabled }),
    reloadReplyPrompt: () => post('/v1/telegram/reply-prompt/reload'),
    listChats: async () => {
      const { data, meta } = await call('GET', `/v1/chats?limit=${CHAT_LIST_LIMIT}`);
      return { chats: data.chats, cursor: data.cursor, total: meta === null ? data.chats.length : meta.total };
    },
    timeline: async (chatId) => (await call('GET', chatPath(chatId, '/timeline'))).data,
    previewErase: async (chatId) => (await call('GET', erasePath(chatId, 'erase-preview'))).data,
    erase: (chatId, expectedSnapshot, key) =>
      post(erasePath(chatId, 'erase'), { expectedSnapshot, confirm: true }, { 'Idempotency-Key': key }),
    eraseTelegram: (chatId, expectedSnapshot, key) =>
      post(erasePath(chatId, 'erase-telegram'), { expectedSnapshot, confirm: true }, { 'Idempotency-Key': key }),
    dispatch: (chatIds, idempotencyKey, officerContext, permission) =>
      post('/v1/dispatches', { chatIds, officerContext, ...permission }, { 'Idempotency-Key': idempotencyKey }),
    dispatchByPhone: (phoneNumber, officerContext, key) =>
      post('/v1/dispatches/by-phone', { phoneNumber, officerContext, participantPermissionRecorded: true }, { 'Idempotency-Key': key }),
    investigationOpener: (officerContext, language) => post('/v1/investigation-opener', { officerContext, language }),
    control: (chatId, action, expectedRevision) => post(chatPath(chatId, '/control'), { action, expectedRevision }),
    sendOfficerMessage: ({ chatId, text, expectedRevision, idempotencyKey }) =>
      post(chatPath(chatId, '/officer-messages'), { text, expectedRevision }, { 'Idempotency-Key': idempotencyKey }),
    leaveUnanswered: (chatId, messageId, expectedRevision) =>
      post(chatPath(chatId, '/officer-decisions'), { decision: 'leave_unanswered', messageId, expectedRevision }),
    markReviewed: (chatId, reviewActionId, expectedRevision) =>
      post(chatPath(chatId, '/officer-decisions'), { decision: 'mark_reviewed', reviewActionId, expectedRevision }),
    retryCapture: (captureId) => post(`/v1/captures/${segment(captureId)}/retry`),
    /** `request`: { kind, paymentHosts, sourceNote } (state/case-reference.js builds it). */
    recordCaseReference: (chatId, request) => post(chatPath(chatId, '/case-references'), request),
    watchlist: async () => (await call('GET', '/v1/watchlist')).data,
    flagScammer: (chatId, phone, reason) => post(chatPath(chatId, '/scammer-flags'), { phone, reason }),
    searchPlaces: async ({ q, category, bbox, limit, cursor }) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (category) params.set('category', category);
      if (bbox) params.set('bbox', bbox);
      params.set('limit', String(limit));
      if (cursor) params.set('cursor', cursor);
      const { data, meta } = await call('GET', `/v1/places/search?${params}`);
      return { places: data.places, nextCursor: data.nextCursor, categories: data.categories ?? [], total: meta === null ? data.places.length : meta.total };
    },
    getPlace: async (placeId) => (await call('GET', `/v1/places/${segment(placeId)}`)).data.place,
    reviewWatchlistEntry: (entryId, decision, reason, expectedRevision) =>
      post(`/v1/watchlist/${segment(entryId)}/review`, { decision, reason, expectedRevision }),
    /** The capture PNG; the caller turns it into an object URL. */
    artifactBlob: (artifactId) => blob(`/v1/artifacts/${segment(artifactId)}`),
    /** A proxied map tile PNG; the caller turns it into an object URL. */
    tileBlob: (z, x, y) => blob(`/v1/map/tiles/${z}/${x}/${y}`),
  };
}
