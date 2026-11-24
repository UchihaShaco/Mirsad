/**
 * One signed-in dashboard session: the state, the loaders and refreshers that fill it, live updates from GET /v1/events,
 * hash routing and the renderer. They share one context object (ctx). Officer actions are in actions.js; the service
 * holds every case rule.
 */
import { createActions } from './actions.js';
import { describeError } from './format.js';
import { applyChat, loadInbox, loadTelegramSetting, loadTimeline, loadWatchlist, refreshBatchReceipts, refreshDispatchReceipt } from './loaders.js';
import { createRefresher, REFRESH_DELAY_MS } from './refresher.js';
import { createRenderer } from './render.js';
import { initialCaseReferenceDraft } from './state/case-reference.js';
import { initialComposer } from './state/composer.js';
import { chatHref, parseRoute } from './state/route.js';
import { createEventStream } from './stream-client.js';
import { createCaptureCache } from './views/capture.js';
import { bindComposer } from './views/composer.js';
import { bindCaseReferenceForm } from './views/side-panel.js';
import { createWatchlistView } from './views/watchlist.js';
import { bindWorkspace, DOCKED_EVIDENCE, resetCaseTools } from './views/workspace.js';
import { bindPhoneDispatch } from './views/phone-dispatch.js';
import { bindScammerFlag } from './views/scammer-flag.js';
import { bindErase } from './views/erase.js';

/** Events that cannot change a chat summary, so they do not reload the inbox. */
const INBOX_NEUTRAL_EVENTS = new Set(['capture.updated']);

function initialState(me) {
  return {
    me, view: 'inbox', connection: 'connecting', notice: null, pending: null,
    chats: [], chatsTotal: 0, inboxLoaded: false, inboxFilter: 'all', selection: new Set(), dispatchBrief: null,
    selectedChatId: null, focusMessageId: null, focusEventId: null, timeline: null, timelineError: null, evidenceOpen: false,
    replyTargetId: null, replyTargetPinned: false, composer: initialComposer(), caseReferenceDraft: initialCaseReferenceDraft(),
    watchlist: { status: 'idle', entries: [], message: null },
    dmReplies: null, consentPrompt: null,
  };
}

function selectChat(ctx, chatId, messageId, eventId = null) {
  if (chatId === ctx.getState().selectedChatId) {
    ctx.setState({ focusMessageId: messageId, focusEventId: eventId });
    return;
  }
  ctx.refreshers.timeline.cancel();
  clearTimeout(ctx.dispatchExpiry);
  ctx.captures.revokeAll();
  ctx.tickets.timeline += 1;
  resetCaseTools(ctx.refs);
  ctx.setState({
    selectedChatId: chatId, focusMessageId: messageId, focusEventId: eventId, timeline: null, timelineError: null, evidenceOpen: false,
    replyTargetId: null, replyTargetPinned: false, composer: initialComposer(), caseReferenceDraft: initialCaseReferenceDraft(),
  });
  if (chatId !== null) ctx.load.timeline().catch(ctx.showError);
}

function applyRoute(ctx) {
  const previous = ctx.getState();
  const route = parseRoute(window.location.hash);
  if (route.view === 'watchlist') {
    resetCaseTools(ctx.refs);
    ctx.setState({ view: 'watchlist', evidenceOpen: false });
    void ctx.load.watchlist();
    return;
  }
  // History may point back to a message while the phone is displaying its evidence pane.
  // Reveal the timeline before selectChat moves focus to that source. Where the pane sits beside the conversation it
  // covers nothing, so it stays open while the officer moves between messages of the same chat.
  const keepEvidence = previous.evidenceOpen && previous.view === 'inbox' && route.chatId !== null
    && route.chatId === previous.selectedChatId && window.matchMedia(DOCKED_EVIDENCE).matches;
  ctx.setState({ view: 'inbox', evidenceOpen: keepEvidence, previousRequested: route.previous === true });
  if (previous.selectedChatId === null && route.chatId !== null) {
    ctx.queueScroll = ctx.refs.inbox.querySelector('.inbox-lists').scrollTop;
  }
  selectChat(ctx, route.chatId, route.messageId, route.eventId);
  if (!window.matchMedia('(max-width: 760px)').matches) return;
  if (route.chatId !== null && route.messageId === null && (previous.selectedChatId !== route.chatId || previous.view !== 'inbox')) {
    ctx.refs.backToInbox.focus({ preventScroll: true });
  } else if (route.chatId === null && previous.selectedChatId !== null) {
    const list = ctx.refs.inbox.querySelector('.inbox-lists');
    const row = [...list.querySelectorAll('li[data-chat-id]')].find(li => li.dataset.chatId === previous.selectedChatId);
    list.scrollTop = ctx.queueScroll;
    (row?.querySelector('.chat-link') ?? ctx.refs.inboxFilterAll).focus({ preventScroll: true });
  }
}

function onStreamEvent(ctx, event) {
  const { view, selectedChatId } = ctx.getState();
  const watchlistEvent = event.type.startsWith('watchlist.');
  if (watchlistEvent && view === 'watchlist') ctx.refreshers.watchlist.request();
  if (!INBOX_NEUTRAL_EVENTS.has(event.type)) ctx.refreshers.inbox.request();
  if (selectedChatId !== null && (event.chatId === selectedChatId || watchlistEvent)) ctx.refreshers.timeline.request();
  if (event.chatId && event.chatId !== selectedChatId && (event.type === 'case_action.recorded' || event.type.startsWith('message.'))) {
    void refreshDispatchReceipt(ctx, event.chatId);
  }
}

/** stream.reset: the position fell outside retained history, so reload the snapshots. */
function onStreamReload(ctx) {
  void refreshBatchReceipts(ctx);
  ctx.refreshers.inbox.request();
  ctx.refreshers.dmReplies.request();
  ctx.refreshers.consentPrompt.request();
  ctx.refreshers.timeline.request();
  if (ctx.getState().view === 'watchlist') ctx.refreshers.watchlist.request();
}

function clearErasedHistory(ctx, id, receipt) {
  ctx.dispatchKeys.clear();
  const state = ctx.getState();
  ctx.forgetErasePreview(id);
  // Fence reads started before erasure, including an inbox or watchlist request already in flight.
  ctx.tickets.inbox++;
  ctx.tickets.watchlist++;
  if (id === null || state.selectedChatId === id) {
    if (ctx.refs.captureDialog.open) ctx.refs.captureDialog.close();
    ctx.refs.captureDialogImage.removeAttribute('src');
    ctx.refs.captureDialogImage.alt = '';
    ctx.refs.composerText.value = '';
    ctx.refs.caseReferenceForm.reset();
    ctx.captures.revokeAll();
    window.history.replaceState(null, '', '#/');
    applyRoute(ctx);
  }
  const chats = id === null ? [] : state.chats.filter(chat => chat.id !== id);
  const selection = new Set(id === null ? [] : [...state.selection].filter(chatId => chatId !== id));
  ctx.setState({
    chats, chatsTotal: id === null ? 0 : state.chatsTotal - (state.chats.length - chats.length), selection,
    dispatchBrief: id === null || state.dispatchBrief?.chatId === id ? null : state.dispatchBrief,
    watchlist: { status: 'idle', entries: [], message: null }, notice: { tone: 'info', text: receipt },
  });
  ctx.watchlistView.clearDrafts();
  ctx.refreshers.inbox.request();
  ctx.refreshers.watchlist.request();
  if (ctx.getState().selectedChatId === null) ctx.refs.inboxFilterAll.focus({ preventScroll: true });
}

function bindPage(ctx) {
  const { refs, handlers } = ctx;
  const { signal } = ctx.listeners;
  bindWorkspace(ctx);
  ctx.forgetErasePreview = bindErase(ctx, ctx.clearErased);
  refs.selectAllChats.addEventListener('change', () => handlers.onSelectAll(refs.selectAllChats.checked), { signal });
  refs.dispatchButton.addEventListener('click', event => { if (event.detail < 2) void handlers.onDispatch(); }, { signal });
  const updateBrief = () => handlers.onDispatchBriefInput(refs.dispatchBriefText.value, refs.dispatchBriefClear.checked);
  refs.dispatchBriefText.addEventListener('input', updateBrief, { signal });
  refs.dispatchBriefClear.addEventListener('change', updateBrief, { signal });
  const openOpener = (briefing = '', recipient = '') => {
    refs.openerForm.reset();
    refs.openerContext.value = briefing;
    refs.openerStatus.textContent = '';
    refs.openerDraft.value = '';
    refs.openerResult.hidden = !recipient;
    refs.copyOpener.hidden = !recipient;
    refs.copyOpener.disabled = Boolean(recipient);
    refs.openerRecipient.hidden = !recipient;
    refs.openerRecipientNumber.textContent = recipient;
    refs.openTelegramDraft.hidden = !recipient;
    refs.openTelegramDraft.disabled = true;
    refs.openerManualHint.textContent = recipient
      ? 'Open the draft in Telegram to review the recipient and send it yourself. You can also copy the draft.'
      : 'Review and edit this local draft, then copy it into Telegram when you’re ready to send.';
    refs.openerDialog.showModal();
    if (recipient) refs.openerDraft.focus();
  };
  refs.openOpener.addEventListener('click', () => openOpener(), { signal });
  bindPhoneDispatch(ctx, openOpener);
  bindScammerFlag(ctx);
  refs.openerDialog.addEventListener('close', () => {
    if (refs.openerDialog.open) return;
    refs.openerForm.reset();
    refs.openerRecipientNumber.textContent = '';
    refs.openerDraft.value = '';
  }, { signal });
  refs.openerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handlers.onGenerateOpener();
  }, { signal });
  refs.openerDraft.addEventListener('input', () => {
    refs.copyOpener.disabled = !refs.openerDraft.value.trim();
    refs.openTelegramDraft.disabled = !refs.openerDraft.value.trim();
  }, { signal });
  refs.copyOpener.addEventListener('click', () => handlers.onCopyOpener(), { signal });
  refs.captureDialog.addEventListener('close', () => refs.captureDialogImage.removeAttribute('src'), { signal });
  bindComposer(refs, handlers, signal);
  bindCaseReferenceForm(refs, handlers, signal);
  window.addEventListener('hashchange', () => applyRoute(ctx), { signal });
  window.addEventListener('focus', () => {
    ctx.refreshers.dmReplies.request();
    ctx.refreshers.consentPrompt.request();
  }, { signal });
}

async function boot(ctx) {
  ctx.render(ctx.getState());
  bindPage(ctx);
  applyRoute(ctx);
  void ctx.load.dmReplies().catch(ctx.showError);
  void ctx.load.consentPrompt().catch(ctx.showError);
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
  clearTimeout(ctx.dispatchExpiry);
  if (ctx.stream !== null) ctx.stream.stop();
  for (const refresher of Object.values(ctx.refreshers)) refresher.cancel();
  ctx.captures.revokeAll();
  if (ctx.refs.captureDialog.open) ctx.refs.captureDialog.close();
  if (ctx.refs.openerDialog.open) ctx.refs.openerDialog.close();
  if (ctx.refs.settingsDialog.open) ctx.refs.settingsDialog.close();
  if (ctx.refs.phoneDialog.open) ctx.refs.phoneDialog.close();
  if (ctx.refs.eraseDialog.open) ctx.refs.eraseDialog.close();
  ctx.refs.eraseChatLabel.textContent = '';
  ctx.refs.eraseTyped.value = '';
  ctx.refs.eraseTelegramResult.replaceChildren();
  ctx.refs.phoneForm.reset();
  ctx.refs.openerRecipientNumber.textContent = '';
  resetCaseTools(ctx.refs);
  ctx.refs.openerForm.reset();
  ctx.refs.openerDraft.value = '';
}

export function startDashboard({ api, me, token, refs, onSessionEnded }) {
  let state = initialState(me);
  const ctx = {
    api, refs, token, onSessionEnded,
    listeners: new AbortController(),
    captures: createCaptureCache(api),
    watchlistView: createWatchlistView(refs.watchlist),
    tickets: { inbox: 0, timeline: 0, watchlist: 0, dmReplies: 0, consentPrompt: 0 },
    stream: null, queueScroll: 0, dispatchKeys: new Map(), dispatchExpiry: null,
    render: () => undefined,
    getState: () => state,
    setState(patch) {
      if (ctx.listeners.signal.aborted) return;
      state = { ...state, ...patch };
      ctx.render(state);
    },
    showError: (error) => ctx.setState({ notice: { tone: 'error', text: describeError(error) } }),
  };
  ctx.load = {
    inbox: () => loadInbox(ctx), timeline: () => loadTimeline(ctx), watchlist: () => loadWatchlist(ctx),
    dmReplies: () => loadTelegramSetting(ctx, 'dmReplies'), consentPrompt: () => loadTelegramSetting(ctx, 'consentPrompt'),
  };
  ctx.applyChat = (chat) => applyChat(ctx, chat);
  ctx.openQueuedDispatch = (timeline, briefing) => {
    const route = chatHref(timeline.chat.id);
    if (window.location.hash !== route) window.history.pushState(null, '', route);
    applyRoute(ctx);
    ctx.setState({ timeline, timelineError: null });
    ctx.beginChatDispatch(timeline, briefing);
  };
  ctx.clearErased = (id, receipt) => clearErasedHistory(ctx, id, receipt);
  ctx.refreshers = Object.fromEntries(Object.entries(ctx.load).map(([name, load]) => [name, createRefresher(load, REFRESH_DELAY_MS, ctx.showError)]));
  ctx.handlers = createActions(ctx);
  ctx.render = createRenderer(ctx);
  boot(ctx).catch(ctx.showError);
  return { stop: () => stop(ctx) };
}
