/**
 * Officer actions. Each one calls a single route and then reloads what it changed; the service decides every rule and
 * answers a stale or refused request with an error, which becomes the notice. Only one action runs at a time.
 */
import { describeCaseReference, describeDispatch, describeError } from './format.js';
import { caseReferenceRequest, initialCaseReferenceDraft } from './state/case-reference.js';
import { updateComposer } from './state/composer.js';
import { briefingChatId, currentDispatchChatId, pruneSelection, toggleSelection } from './state/inbox.js';

/** Errors that mean the dashboard's copy of the chat is out of date: show the error, then reload. */
const STALE_VIEW_ERRORS = new Set(['revision_conflict', 'not_controller', 'not_in_takeover', 'invalid_transition', 'capture_not_retryable']);
/** The service refuses a confirmation with validation_failed, most often for a host it cannot parse. */
const CONFIRMATION_REFUSED = 'The confirmation was not accepted. Enter each payment host as a host name, host:port or URL.';

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
  if (ctx.getState().pending !== null) return false;
  ctx.setState({ pending: name, notice: null });
  try {
    return await action();
  } catch (error) {
    ctx.setState({ notice: { tone: 'error', text: describeError(error) } });
    await reloadAfterError(ctx, error);
    return false;
  } finally {
    ctx.setState({ pending: null });
  }
}

async function finishDispatch(ctx, chatIds, result, receipt) {
  info(ctx, receipt ?? describeDispatch(result.results));
  try {
    await ctx.load.inbox();
    if (chatIds.includes(ctx.getState().selectedChatId)) await ctx.load.timeline();
  } catch (error) {
    // The server already accepted the dispatch. A read failure must not invite a repeat submission.
    ctx.showError(error);
  }
}

async function dispatchSelected(ctx) {
  const state = ctx.getState();
  const chatIds = [...pruneSelection(state.selection, state.chats, state.inboxFilter)];
  if (chatIds.length === 0) return;
  const brief = state.dispatchBrief;
  const officerContext = brief !== null && brief.chatId === briefingChatId(state)
    ? (brief.clear ? null : brief.text.trim() || undefined) : undefined;
  const result = await ctx.api.dispatch(chatIds, crypto.randomUUID(), officerContext);
  ctx.setState({ selection: new Set(), dispatchBrief: null });
  await finishDispatch(ctx, chatIds, result);
}

function dispatchCurrent(ctx, officerContext, expectedChatId, permission, live) {
  const chatId = currentDispatchChatId(ctx.getState(), expectedChatId);
  if (chatId === null) return Promise.resolve(false);
  return run(ctx, 'dispatch_current', async () => {
    const result = await ctx.api.dispatch([chatId], crypto.randomUUID(), officerContext, permission);
    const receipt = live && result.results.some(item => item.chatId === chatId && item.status !== 'requires_resume')
      ? 'Dispatch accepted. Check the conversation for a reply, a silence reason or an officer review request.' : undefined;
    await finishDispatch(ctx, [chatId], result, receipt);
    return result.results.some(item => item.chatId === chatId && item.status !== 'requires_resume')
      && currentDispatchChatId(ctx.getState(), chatId) === chatId;
  });
}

async function generateOpener(ctx) {
  const { refs } = ctx;
  const briefing = refs.openerContext.value.trim();
  if (!briefing || ctx.getState().pending !== null) return;
  ctx.setState({ pending: 'investigation_opener' });
  refs.openerStatus.className = 'hint';
  refs.openerStatus.textContent = 'Generating draft…';
  const officerEditing = !refs.openerRecipient.hidden;
  refs.openerResult.hidden = !officerEditing;
  refs.copyOpener.hidden = !officerEditing;
  const previousDraft = refs.openerDraft.value;
  try {
    const { draft } = await ctx.api.investigationOpener(briefing, refs.openerLanguage.value);
    if (ctx.listeners.signal.aborted || !refs.openerDialog.open) return;
    if (refs.openerDraft.value !== previousDraft) {
      refs.openerStatus.textContent = 'Your edited draft is ready.';
      return;
    }
    refs.openerDraft.value = draft;
    refs.openerResult.hidden = false;
    refs.copyOpener.hidden = false;
    refs.copyOpener.disabled = !draft.trim();
    refs.openTelegramDraft.disabled = !draft.trim();
    refs.openerStatus.textContent = '';
    refs.openerDraft.focus();
  } catch (error) {
    if (ctx.listeners.signal.aborted || !refs.openerDialog.open) return;
    refs.openerStatus.className = 'error';
    refs.openerStatus.textContent = describeError(error);
  } finally {
    ctx.setState({ pending: null });
  }
}

async function copyOpener(refs) {
  if (!refs.openerDraft.value.trim()) return;
  try {
    await navigator.clipboard.writeText(refs.openerDraft.value);
    refs.openerStatus.className = 'hint';
    refs.openerStatus.textContent = 'Draft copied.';
  } catch {
    refs.openerDraft.select();
    refs.openerStatus.className = 'hint';
    refs.openerStatus.textContent = 'The draft is selected and ready to copy.';
  }
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

/** Records a merchant payment confirmation for the open chat; the service marks conflicting payment links. */
async function recordCaseReference(ctx) {
  const chat = chatInView(ctx);
  const request = caseReferenceRequest(ctx.getState().caseReferenceDraft);
  if (chat === null || request === null) return;
  let result;
  try {
    result = await ctx.api.recordCaseReference(chat.id, request);
  } catch (error) {
    throw error?.code === 'validation_failed' ? new Error(CONFIRMATION_REFUSED) : error;
  }
  // The draft belongs to the chat it was typed for; another chat opened meanwhile keeps its own.
  if (ctx.getState().selectedChatId === chat.id) ctx.setState({ caseReferenceDraft: initialCaseReferenceDraft() });
  info(ctx, describeCaseReference(result.findingsCreated));
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

function toggleTelegramSetting(ctx, name, save) {
  return run(ctx, name, async () => {
    const current = ctx.getState()[name];
    if (!current?.available && !current?.enabled) return;
    // A snapshot requested before the click must not replace the result of this change.
    ctx.tickets[name] += 1;
    try {
      const setting = await save(!current.enabled);
      ctx.setState({ [name]: setting });
      if (name === 'dmReplies' && !setting.available && !setting.enabled) info(ctx, 'Automatic replies are off for the linked Telegram account.');
    } catch (error) {
      ctx.refreshers[name].request();
      throw error;
    }
  });
}

export function createActions(ctx) {
  const { getState, setState } = ctx;
  return {
    onInboxFilter: (filter) => {
      const state = getState();
      if (filter === state.inboxFilter || !['all', 'review', 'lower_concern'].includes(filter)) return;
      const selection = pruneSelection(state.selection, state.chats, filter);
      const eligibleId = briefingChatId({ ...state, selection });
      setState({ inboxFilter: filter, selection, dispatchBrief: state.dispatchBrief?.chatId === eligibleId ? state.dispatchBrief : null });
    },
    onToggleSelect: (chatId, selected) => {
      const state = getState();
      const selection = toggleSelection(state.selection, chatId, selected);
      const eligibleId = briefingChatId({ ...state, selection });
      setState({ selection, dispatchBrief: state.dispatchBrief?.chatId === eligibleId ? state.dispatchBrief : null });
    },
    onDispatchBriefInput: (text, clear) => {
      const chatId = briefingChatId(getState());
      if (chatId !== null) setState({ dispatchBrief: { chatId, text, clear } });
    },
    onDispatch: () => run(ctx, 'dispatch', () => dispatchSelected(ctx)),
    onDispatchCurrent: (officerContext, expectedChatId, permission, live) => dispatchCurrent(ctx, officerContext, expectedChatId, permission, live),
    onGenerateOpener: () => generateOpener(ctx),
    onCopyOpener: () => copyOpener(ctx.refs),
    onSetDmReplies: () => toggleTelegramSetting(ctx, 'dmReplies', ctx.api.setDmReplies),
    onReloadReplyPrompt: () => run(ctx, 'reload_reply_prompt', async () => {
      try {
        const { changed } = await ctx.api.reloadReplyPrompt();
        info(ctx, changed ? 'Saved prompt loaded. Ali will use it for the next reply.' : 'Ali is already using the saved prompt.');
      } catch (error) {
        let text = 'Could not confirm the prompt reload. Try again.';
        if (error.code === 'reply_prompt_unavailable') text = 'Check the saved prompt file and try again. Ali is still using the last working prompt.';
        if (error.status === 403 || error.code === 'account_not_found') text = 'Reloading the prompt requires access to the linked Telegram account.';
        setState({ notice: { tone: 'error', text } });
      }
    }),
    onSetTestMode: () => toggleTelegramSetting(ctx, 'consentPrompt', ctx.api.setConsentPrompt),
    onControl: (action) => run(ctx, `control:${action}`, () => control(ctx, action)),
    // An explicit pick: reloads keep it while the message exists instead of moving to newer messages.
    onSelectReplyTarget: (messageId) => setState({ replyTargetId: messageId, replyTargetPinned: true }),
    onComposerInput: (text) => setState({ composer: updateComposer(getState().composer, { type: 'edit', text }).state }),
    onInsertAcknowledgement: () => insertAcknowledgement(ctx),
    onSend: () => run(ctx, 'send', () => send(ctx)),
    onLeaveUnanswered: () => run(ctx, 'leave_unanswered', () => leaveUnanswered(ctx)),
    onMarkReviewed: (chatId, actionId, revision) => run(ctx, 'mark_reviewed', async () => {
      await ctx.api.markReviewed(chatId, actionId, revision);
      await Promise.all([ctx.load.timeline(), ctx.load.inbox()]);
    }),
    onRetryCapture: (captureId) => run(ctx, 'retry_capture', () => retryCapture(ctx, captureId)),
    onCaseReferenceInput: (draft) => setState({ caseReferenceDraft: draft }),
    onRecordCaseReference: () => run(ctx, 'case_reference', () => recordCaseReference(ctx)),
    onEnlargeCapture: (url, alt) => enlargeCapture(ctx, url, alt),
    onReviewEntry: (entry, decision, reason) => run(ctx, 'watchlist_review', () => reviewEntry(ctx, entry, decision, reason)),
    onReloadWatchlist: () => ctx.load.watchlist().catch(ctx.showError),
  };
}
