/**
 * Loaders: each reads one resource from the API into the dashboard state. Per resource the latest request wins: an
 * answer that arrives after a newer request was made, or after the officer moved to another chat, is dropped.
 */
import { ApiError } from './api.js';
import { describeError } from './format.js';
import { canCompose, initialComposer } from './state/composer.js';
import { initialCaseReferenceDraft } from './state/case-reference.js';
import { pruneSelection } from './state/inbox.js';
import { replyTargetAfterReload, timelineForPeriod } from './state/timeline.js';
import { resetCaseTools } from './views/workspace.js';

const NOT_IMPLEMENTED = 501;

/** Puts a fresher chat summary into the inbox list; a summary with an older control revision is not applied. */
function mergeChat(chats, chat) {
  return chats.map((item) => (item.id === chat.id && chat.revision >= item.revision ? chat : item));
}

/** Loads the inbox; returns the snapshot cursor the event stream starts from. */
export async function loadInbox(ctx) {
  const ticket = ++ctx.tickets.inbox;
  const { chats, cursor, total } = await ctx.api.listChats();
  if (ticket === ctx.tickets.inbox) {
    const state = ctx.getState();
    ctx.setState({ chats, chatsTotal: total, inboxLoaded: true, selection: pruneSelection(state.selection, chats, state.inboxFilter) });
  }
  return cursor;
}

export async function loadTelegramSetting(ctx, name) {
  if (ctx.getState().pending === name) return;
  const ticket = ++ctx.tickets[name];
  const setting = await ctx.api[name]();
  if (ticket === ctx.tickets[name]) ctx.setState({ [name]: setting });
}

async function fetchTimeline(ctx, chatId, ticket) {
  try {
    return await ctx.api.timeline(chatId);
  } catch (error) {
    if (ticket !== ctx.tickets.timeline || ctx.getState().selectedChatId !== chatId) return null;
    if (!(error instanceof ApiError && error.code === 'chat_not_found')) throw error;
    ctx.setState({ timeline: null, timelineError: 'This chat is not available to you.' });
    return null;
  }
}

export async function loadTimeline(ctx) {
  const chatId = ctx.getState().selectedChatId;
  if (chatId === null) return;
  const ticket = ++ctx.tickets.timeline;
  const timeline = await fetchTimeline(ctx, chatId, ticket);
  const state = ctx.getState();
  if (timeline === null || ticket !== ctx.tickets.timeline || state.selectedChatId !== chatId) return;
  const justReset = state.timeline !== null && timeline.testSession?.position !== state.timeline.testSession?.position;
  if (justReset && timeline.caseActions.some(action => action.position === timeline.testSession?.position
    && action.type === 'chat_test_started' && action.detail?.erased === true)) {
    ctx.clearErased(chatId, 'This conversation’s local history was erased.');
    return;
  }
  if (justReset) resetCaseTools(ctx.refs);
  const keepComposer = !justReset && (canCompose(timeline.chat, state.me) || state.composer.sending);
  const target = replyTargetAfterReload({ id: state.replyTargetId, pinned: state.replyTargetPinned }, timelineForPeriod(timeline, false));
  ctx.setState({
    timeline,
    timelineError: null,
    replyTargetId: target.id,
    replyTargetPinned: target.pinned,
    composer: keepComposer ? state.composer : initialComposer(),
    ...(justReset && { caseReferenceDraft: initialCaseReferenceDraft(),
      dispatchBrief: state.dispatchBrief?.chatId === chatId ? null : state.dispatchBrief }),
    chats: mergeChat(state.chats, timeline.chat),
  });
}

/** Never throws: a 501 (route not built yet) shows "not available", any other failure shows an error with a retry. */
export async function loadWatchlist(ctx) {
  const ticket = ++ctx.tickets.watchlist;
  try {
    const { entries } = await ctx.api.watchlist();
    if (ticket === ctx.tickets.watchlist) ctx.setState({ watchlist: { status: 'ready', entries, message: null } });
  } catch (error) {
    if (ticket !== ctx.tickets.watchlist) return;
    const unavailable = error instanceof ApiError && error.status === NOT_IMPLEMENTED;
    const current = ctx.getState().watchlist;
    ctx.setState({
      watchlist: unavailable ? { status: 'unavailable', entries: [], message: null } : { ...current, status: 'error', message: describeError(error) },
    });
  }
}

/** Applies a chat summary from a control answer to the open timeline and the inbox list at once. */
export function applyChat(ctx, chat) {
  const { timeline, chats } = ctx.getState();
  ctx.setState({
    timeline: timeline !== null && timeline.chat.id === chat.id ? { ...timeline, chat } : timeline,
    chats: mergeChat(chats, chat),
  });
}
