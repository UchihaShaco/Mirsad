/**
 * Loaders: each reads one resource from the API into the dashboard state. Per resource the latest request wins: an
 * answer that arrives after a newer request was made, or after the officer moved to another chat, is dropped.
 */
import { ApiError } from './api.js';
import { describeError } from './format.js';
import { canCompose, initialComposer } from './state/composer.js';
import { pruneSelection } from './state/inbox.js';
import { latestIncomingMessageId } from './state/timeline.js';

const NOT_IMPLEMENTED = 501;

/** Keeps the officer's selected incoming message while it exists; otherwise the newest incoming message. */
function chooseReplyTarget(current, timeline) {
  const kept = timeline.messages.some((m) => m.id === current && m.direction === 'incoming' && m.origin === 'source');
  return kept ? current : latestIncomingMessageId(timeline);
}

/** Puts a fresher chat summary into the inbox list; a summary with an older control revision is not applied. */
function mergeChat(chats, chat) {
  return chats.map((item) => (item.id === chat.id && chat.revision >= item.revision ? chat : item));
}

/** Loads the inbox; returns the snapshot cursor the event stream starts from. */
export async function loadInbox(ctx) {
  const ticket = ++ctx.tickets.inbox;
  const { chats, cursor, total } = await ctx.api.listChats();
  if (ticket === ctx.tickets.inbox) {
    ctx.setState({ chats, chatsTotal: total, inboxLoaded: true, selection: pruneSelection(ctx.getState().selection, chats) });
  }
  return cursor;
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
  const keepComposer = canCompose(timeline.chat, state.me) || state.composer.sending;
  ctx.setState({
    timeline,
    timelineError: null,
    replyTargetId: chooseReplyTarget(state.replyTargetId, timeline),
    composer: keepComposer ? state.composer : initialComposer(),
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
