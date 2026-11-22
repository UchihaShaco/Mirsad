/**
 * One signed-in dashboard session: the state, the loaders and refreshers that fill it, live updates from GET /v1/events,
 * hash routing and the renderer. They share one context object (ctx). Officer actions are in actions.js; the service
 * holds every case rule.
 */
import { createActions } from './actions.js';
import { describeError } from './format.js';
import { applyChat, loadInbox, loadTimeline, loadWatchlist } from './loaders.js';
import { createRefresher, REFRESH_DELAY_MS } from './refresher.js';
import { createRenderer } from './render.js';
import { initialComposer } from './state/composer.js';
import { parseRoute } from './state/route.js';
import { createEventStream } from './stream-client.js';
import { createCaptureCache } from './views/capture.js';
import { bindComposer } from './views/composer.js';
import { createWatchlistView } from './views/watchlist.js';

/** Events that cannot change a chat summary, so they do not reload the inbox. */
const INBOX_NEUTRAL_EVENTS = new Set(['capture.updated']);

function initialState(me) {
  return {
    me, view: 'inbox', connection: 'connecting', notice: null, pending: null,
    chats: [], chatsTotal: 0, inboxLoaded: false, selection: new Set(),
    selectedChatId: null, focusMessageId: null, timeline: null, timelineError: null,
    replyTargetId: null, replyTargetPinned: false, composer: initialComposer(),
    watchlist: { status: 'idle', entries: [], message: null },
  };
}

function selectChat(ctx, chatId, messageId) {
  if (chatId === ctx.getState().selectedChatId) {
    ctx.setState({ focusMessageId: messageId });
    return;
  }
  ctx.refreshers.timeline.cancel();
  ctx.captures.revokeAll();
  ctx.tickets.timeline += 1;
  ctx.setState({
    selectedChatId: chatId, focusMessageId: messageId, timeline: null, timelineError: null,
    replyTargetId: null, replyTargetPinned: false, composer: initialComposer(),
  });
  if (chatId !== null) ctx.load.timeline().catch(ctx.showError);
}

function applyRoute(ctx) {
  const route = parseRoute(window.location.hash);
  if (route.view === 'watchlist') {
    ctx.setState({ view: 'watchlist' });
    void ctx.load.watchlist();
    return;
  }
  ctx.setState({ view: 'inbox' });
  selectChat(ctx, route.chatId, route.messageId);
}

function onStreamEvent(ctx, event) {
  const { view, selectedChatId } = ctx.getState();
  const watchlistEvent = event.type.startsWith('watchlist.');
  if (watchlistEvent && view === 'watchlist') ctx.refreshers.watchlist.request();
  if (!INBOX_NEUTRAL_EVENTS.has(event.type)) ctx.refreshers.inbox.request();
  if (selectedChatId !== null && (event.chatId === selectedChatId || watchlistEvent)) ctx.refreshers.timeline.request();
}

/** stream.reset: the position fell outside retained history, so reload the snapshots. */
function onStreamReload(ctx) {
  ctx.refreshers.inbox.request();
  ctx.refreshers.timeline.request();
  if (ctx.getState().view === 'watchlist') ctx.refreshers.watchlist.request();
}

function bindPage(ctx) {
  const { refs, handlers } = ctx;
  const { signal } = ctx.listeners;
  refs.dispatchButton.addEventListener('click', () => handlers.onDispatch(), { signal });
  refs.captureDialog.addEventListener('close', () => refs.captureDialogImage.removeAttribute('src'), { signal });
  bindComposer(refs, handlers, signal);
  window.addEventListener('hashchange', () => applyRoute(ctx), { signal });
}

async function boot(ctx) {
  ctx.render(ctx.getState());
  bindPage(ctx);
  applyRoute(ctx);
  let cursor = null;
  try {
    cursor = await ctx.load.inbox();
  } catch (error) {
    // Without a snapshot cursor the stream starts at the head; its events reload the inbox.
    ctx.showError(error);
  }
  if (ctx.listeners.signal.aborted) return;
  ctx.stream = createEventStream({
    token: ctx.token,
    cursor,
    onEvent: (event) => onStreamEvent(ctx, event),
    onReload: () => onStreamReload(ctx),
    onUnauthorized: ctx.onSessionEnded,
    onStatus: (connection) => ctx.setState({ connection }),
  });
  ctx.stream.start();
}

function stop(ctx) {
  ctx.listeners.abort();
  if (ctx.stream !== null) ctx.stream.stop();
  for (const refresher of Object.values(ctx.refreshers)) refresher.cancel();
  ctx.captures.revokeAll();
  if (ctx.refs.captureDialog.open) ctx.refs.captureDialog.close();
}

export function startDashboard({ api, me, token, refs, onSessionEnded }) {
  let state = initialState(me);
  const ctx = {
    api, refs, token, onSessionEnded,
    listeners: new AbortController(),
    captures: createCaptureCache(api),
    watchlistView: createWatchlistView(refs.watchlist),
    tickets: { inbox: 0, timeline: 0, watchlist: 0 },
    stream: null,
    render: () => undefined,
    getState: () => state,
    setState(patch) {
      if (ctx.listeners.signal.aborted) return;
      state = { ...state, ...patch };
      ctx.render(state);
    },
    showError: (error) => ctx.setState({ notice: { tone: 'error', text: describeError(error) } }),
  };
  ctx.load = { inbox: () => loadInbox(ctx), timeline: () => loadTimeline(ctx), watchlist: () => loadWatchlist(ctx) };
  ctx.applyChat = (chat) => applyChat(ctx, chat);
  ctx.refreshers = Object.fromEntries(Object.entries(ctx.load).map(([name, load]) => [name, createRefresher(load, REFRESH_DELAY_MS, ctx.showError)]));
  ctx.handlers = createActions(ctx);
  ctx.render = createRenderer(ctx);
  boot(ctx).catch(ctx.showError);
  return { stop: () => stop(ctx) };
}
