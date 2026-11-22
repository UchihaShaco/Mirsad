/**
 * Officer actions. Each one calls a single route and then reloads what it changed; the service decides every rule and
 * answers a stale or refused request with an error, which becomes the notice. Only one action runs at a time.
 */
import { describeDispatch, describeError } from './format.js';
import { updateComposer } from './state/composer.js';
import { toggleSelection } from './state/inbox.js';

/** Errors that mean the dashboard's copy of the chat is out of date: show the error, then reload. */
const STALE_VIEW_ERRORS = new Set(['revision_conflict', 'not_controller', 'not_in_takeover', 'invalid_transition', 'capture_not_retryable']);

const info = (ctx, text) => ctx.setState({ notice: { tone: 'info', text } });
const chatInView = (ctx) => (ctx.getState().timeline === null ? null : ctx.getState().timeline.chat);

async function reloadAfterError(ctx, error) {
  if (!STALE_VIEW_ERRORS.has(error?.code)) return;
  try {
    await Promise.all([ctx.load.timeline(), ctx.load.inbox()]);
  } catch (reloadError) {
    ctx.showError(reloadError);
  }
}

async function run(ctx, name, action) {
  if (ctx.getState().pending !== null) return;
  ctx.setState({ pending: name, notice: null });
  try {
    await action();
  } catch (error) {
    ctx.setState({ notice: { tone: 'error', text: describeError(error) } });
    await reloadAfterError(ctx, error);
  } finally {
    ctx.setState({ pending: null });
  }
}

async function dispatchSelected(ctx) {
  const chatIds = [...ctx.getState().selection];
  if (chatIds.length === 0) return;
  const result = await ctx.api.dispatch(chatIds, crypto.randomUUID());
  ctx.setState({ selection: new Set() });
  info(ctx, describeDispatch(result.results));
  await ctx.load.inbox();
  if (chatIds.includes(ctx.getState().selectedChatId)) await ctx.load.timeline();
}

async function control(ctx, action) {
  const chat = chatInView(ctx);
  if (chat === null) return;
  const result = await ctx.api.control(chat.id, action, chat.revision);
  ctx.applyChat(result.chat);
  await Promise.all([ctx.load.timeline(), ctx.load.inbox()]);
}

async function send(ctx) {
  const chat = chatInView(ctx);
  if (chat === null) return;
  const { me, composer } = ctx.getState();
  const attempt = updateComposer(composer, { type: 'send', chat, me, newKey: crypto.randomUUID() });
  if (attempt.request === null) return;
  ctx.setState({ composer: attempt.state });
  try {
    await ctx.api.sendOfficerMessage(attempt.request);
  } catch (error) {
    ctx.setState({ composer: updateComposer(ctx.getState().composer, { type: 'send_failed' }).state });
    throw error;
  }
  ctx.setState({ composer: updateComposer(ctx.getState().composer, { type: 'send_succeeded' }).state });
  info(ctx, 'Reply recorded in the timeline as a simulated send.');
  await ctx.load.timeline();
}

async function leaveUnanswered(ctx) {
  const chat = chatInView(ctx);
  const messageId = ctx.getState().replyTargetId;
  if (chat === null || messageId === null) return;
  const { created } = await ctx.api.leaveUnanswered(chat.id, messageId, chat.revision);
  info(ctx, created ? 'Recorded in the case log: Leave unanswered.' : 'That message is already marked Leave unanswered.');
  await ctx.load.timeline();
}

async function retryCapture(ctx, captureId) {
  await ctx.api.retryCapture(captureId);
  info(ctx, 'Capture retry requested.');
  await ctx.load.timeline();
}

async function reviewEntry(ctx, entry, decision, reason) {
  await ctx.api.reviewWatchlistEntry(entry.id, decision, reason, entry.revision);
  ctx.watchlistView.clearDraft(entry.id);
  info(ctx, 'Watchlist decision recorded.');
  await ctx.load.watchlist();
}

function insertAcknowledgement(ctx) {
  const chat = chatInView(ctx);
  if (chat !== null) ctx.setState({ composer: updateComposer(ctx.getState().composer, { type: 'insert_acknowledgement', chat }).state });
}

function enlargeCapture(ctx, url, alt) {
  ctx.refs.captureDialogImage.src = url;
  ctx.refs.captureDialogImage.alt = alt;
  ctx.refs.captureDialog.showModal();
}

export function createActions(ctx) {
  const { getState, setState } = ctx;
  return {
    onToggleSelect: (chatId, selected) => setState({ selection: toggleSelection(getState().selection, chatId, selected) }),
    onDispatch: () => run(ctx, 'dispatch', () => dispatchSelected(ctx)),
    onControl: (action) => run(ctx, `control:${action}`, () => control(ctx, action)),
    // An explicit pick: reloads keep it while the message exists instead of moving to newer messages.
    onSelectReplyTarget: (messageId) => setState({ replyTargetId: messageId, replyTargetPinned: true }),
    onComposerInput: (text) => setState({ composer: updateComposer(getState().composer, { type: 'edit', text }).state }),
    onInsertAcknowledgement: () => insertAcknowledgement(ctx),
    onSend: () => run(ctx, 'send', () => send(ctx)),
    onLeaveUnanswered: () => run(ctx, 'leave_unanswered', () => leaveUnanswered(ctx)),
    onRetryCapture: (captureId) => run(ctx, 'retry_capture', () => retryCapture(ctx, captureId)),
    onEnlargeCapture: (url, alt) => enlargeCapture(ctx, url, alt),
    onReviewEntry: (entry, decision, reason) => run(ctx, 'watchlist_review', () => reviewEntry(ctx, entry, decision, reason)),
    onReloadWatchlist: () => ctx.load.watchlist().catch(ctx.showError),
  };
}
