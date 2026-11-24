/**
 * Loaders: each reads one resource from the API into the dashboard state. Per resource the latest request wins: an
 * answer that arrives after a newer request was made, or after the officer moved to another chat, is dropped.
 */
import { ApiError } from './api.js';
import { describeError, telegramRequestReceipt } from './format.js';
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

function updateDispatchReceipt(ctx, timeline) {
  const notice = ctx.getState().notice;
  const latest = timeline.telegramReplies?.request;
  if (!latest || !notice?.dispatchRows) return;
  const row = notice.dispatchRows.find(row => row.pending && row.chatId === timeline.chat.id);
  if (!row) return;
  // More than one stream event can refresh a receipt. An older snapshot must never restore a cleared hold.
  const through = timeline.caseActions.at(-1)?.position ?? 0;
  if (through < (row.through ?? 0)) return;
  const deliveryStates = { ai_reply_sent: 'sent', ai_reply_failed: 'failed', ai_reply_skipped: 'skipped' };
  let request = latest;
  if (latest.id !== row.requestId) {
    // A read begun before this Dispatch can finish after its receipt. Only a snapshot containing it is authoritative.
    if (!timeline.caseActions.some(item => item.id === row.requestId && item.type === 'telegram_reply_requested')) return;
    const action = timeline.caseActions.findLast(item => item.detail?.requestId === row.requestId && Object.hasOwn(deliveryStates, item.type));
    request = action ? { id: row.requestId, kind: row.kind, status: deliveryStates[action.type], failureCode: action.detail.code } : null;
  }
  const pending = request?.status === 'queued' || request?.status === 'held';
  const automatic = timeline.telegramReplies.automatic === 'active' ? ' Automatic replies are on for future messages.' : '';
  const text = (request ? telegramRequestReceipt(request, timeline.caseActions) : 'A newer Dispatch is on record. Open the case log for the earlier outcome.') + automatic;
  if (row.text === text && row.pending === pending && row.through === through) return;
  const dispatchRows = notice.dispatchRows.map(item => item === row ? { ...row, pending, text, through } : item);
  ctx.setState({ notice: { ...notice, dispatchRows, text: dispatchRows.map(item => item.text).join(' ') } });
}

/** A receipt for an unselected chat only reloads when its request still awaits a delivery result. */
export async function refreshDispatchReceipt(ctx, chatId) {
  if (!ctx.getState().notice?.dispatchRows?.some(row => row.chatId === chatId && row.pending)) return;
  try {
    const timeline = await ctx.api.timeline(chatId);
    if (!ctx.listeners.signal.aborted) updateDispatchReceipt(ctx, timeline);
  } catch {
    // Keep the recorded queue receipt. Opening the chat still reads its latest delivery status.
  }
}

export async function refreshBatchReceipts(ctx) {
  for (const row of ctx.getState().notice?.dispatchRows ?? []) {
    if (ctx.listeners.signal.aborted) return;
    if (row.pending && row.chatId !== ctx.getState().selectedChatId) await refreshDispatchReceipt(ctx, row.chatId);
  }
}

export async function loadTimeline(ctx) {
  const chatId = ctx.getState().selectedChatId;
  if (chatId === null) return;
  const ticket = ++ctx.tickets.timeline;
  const timeline = await fetchTimeline(ctx, chatId, ticket);
  const state = ctx.getState();
  if (timeline === null || ticket !== ctx.tickets.timeline || state.selectedChatId !== chatId) return;
  updateDispatchReceipt(ctx, timeline);
  // Expiry alone does not publish an event. Refresh the selected request when its server deadline passes.
  clearTimeout(ctx.dispatchExpiry);
  const request = timeline.telegramReplies?.request;
  if (request?.status === 'queued') {
    const until = timeline.caseActions.find(action => action.id === request.id)?.detail?.until;
    if (typeof until === 'number') {
      ctx.dispatchExpiry = setTimeout(() => {
        if (!ctx.listeners.signal.aborted && ctx.getState().selectedChatId === chatId) ctx.refreshers.timeline.request();
      }, Math.max(1000, until - Date.now() + 100));
    }
  }
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
