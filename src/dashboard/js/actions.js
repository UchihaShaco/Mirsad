/**
 * Officer actions. Each one calls a single route and then reloads what it changed; the service decides every rule and
 * answers a stale or refused request with an error, which becomes the notice. Only one action runs at a time.
 */
import { describeCaseReference, describeDispatch, describeError, telegramDispatchReceipt } from './format.js';
import { refreshBatchReceipts } from './loaders.js';
import { caseReferenceRequest, initialCaseReferenceDraft } from './state/case-reference.js';
import { updateComposer } from './state/composer.js';
import { briefingChatId, currentDispatchChatId, DISPATCH_LIMIT, pruneSelection, selectableChatIds, telegramDispatchRequest, toggleSelection } from './state/inbox.js';

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

async function finishDispatch(ctx, chatIds, result) {
  if (result.results.some(item => item.telegram)) {
    const chats = ctx.getState().chats;
    const rows = result.results.map(item => ({
      chatId: item.chatId, label: chats.find(chat => chat.id === item.chatId)?.displayLabel ?? item.chatId,
      text: item.telegram ? telegramDispatchReceipt(item.telegram) : describeDispatch([item]),
      requestId: item.telegram?.requestId ?? null, kind: item.telegram?.kind, pending: item.telegram?.reply === 'queued',
    }));
    ctx.setState({ notice: { tone: 'info', text: rows.map(row => row.text).join(' '), dispatchRows: rows } });
    // Delivery can finish before the HTTP receipt reaches the browser, ahead of its live-event subscription.
    void refreshBatchReceipts(ctx);
  } else if (chatIds.length === 1 && ctx.getState().timeline?.chat.id === chatIds[0] &&
      ctx.getState().timeline.messages.some(message => message.source.captureMethod === 'telegram_business_live')) {
    info(ctx, 'Dispatch returned without a Telegram delivery receipt. Check the chat timeline. The running service must support reply requests to show their status.');
  } else if (chatIds.length === 1 && ctx.getState().timeline?.chat.id === chatIds[0] &&
      ctx.getState().timeline.messages.some(message => message.source.captureMethod === 'whatsapp_business_live') &&
      result.results[0]?.status !== 'requires_resume') {
    info(ctx, 'Dispatch accepted. The AI will assess the latest eligible unanswered message.');
  } else {
    info(ctx, describeDispatch(result.results));
  }
  try {
    await ctx.load.inbox();
    if (chatIds.includes(ctx.getState().selectedChatId)) await ctx.load.timeline();
  } catch (error) {
    // The server already returned the receipts. A failed reload must keep them on screen.
    const notice = ctx.getState().notice;
    if (notice?.dispatchRows) {
      ctx.setState({ notice: { ...notice, refreshNote: 'Dispatch was accepted. Refresh the inbox to see the latest delivery status.' } });
    } else {
      ctx.showError(error);
    }
  }
}

// Keep the same key after an uncertain network result. A confirmed result completes that deliberate action.
async function submitDispatch(ctx, chatIds, officerContext, permission) {
  const fingerprint = JSON.stringify({ chatIds, officerContext, ...permission });
  const keys = ctx.dispatchKeys;
  const key = keys.get(fingerprint) ?? crypto.randomUUID();
  keys.set(fingerprint, key);
  try {
    const response = await ctx.api.dispatch(chatIds, key, officerContext, permission);
    keys.delete(fingerprint);
    return response;
  } catch (error) {
    if (error.status >= 400 && error.status < 500) keys.delete(fingerprint);
    throw error;
  }
}

async function dispatchSelected(ctx) {
  const state = ctx.getState();
  const selected = pruneSelection(state.selection, state.chats, state.inboxFilter);
  const chatIds = [...selected];
  if (chatIds.length === 0 || chatIds.length > DISPATCH_LIMIT) return;
  const brief = state.dispatchBrief;
  const officerContext = brief !== null && brief.chatId === briefingChatId(state)
    ? (brief.clear ? null : brief.text.trim() || undefined) : undefined;
  if (chatIds.length === 1 && state.chats.find(chat => chat.id === chatIds[0])?.source === 'telegram') {
    const timeline = await ctx.api.timeline(chatIds[0]);
    const current = ctx.getState();
    if (ctx.listeners.signal.aborted || current.selectedChatId !== state.selectedChatId
      || current.view !== 'inbox' || current.selection.size !== 1 || !current.selection.has(chatIds[0])) return;
    if ((timeline.telegramReplies || timeline.messages.some(message => message.source.captureMethod === 'telegram_business_live'))
      && ['not_started', 'ai_active'].includes(timeline.chat.aiMode)) {
      return { timeline, officerContext };
    }
  }
  const includesTelegram = state.chats.some(chat => selected.has(chat.id) && chat.source === 'telegram');
  const result = await submitDispatch(ctx, chatIds, officerContext, includesTelegram ? telegramDispatchRequest() : undefined);
  ctx.setState({ selection: new Set(), dispatchBrief: null });
  await finishDispatch(ctx, chatIds, result);
}

function dispatchCurrent(ctx, officerContext, expectedChatId, permission) {
  const chatId = currentDispatchChatId(ctx.getState(), expectedChatId);
  if (chatId === null) return Promise.resolve(false);
  return run(ctx, 'dispatch_current', async () => {
    const result = await submitDispatch(ctx, [chatId], officerContext, permission);
    if (ctx.getState().selection.size === 1 && ctx.getState().selection.has(chatId)) {
      ctx.setState({ selection: new Set(), dispatchBrief: null });
    }
    await finishDispatch(ctx, [chatId], result);
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
  function setSelection(state, selection, inboxFilter = state.inboxFilter) {
    const eligibleId = briefingChatId({ ...state, selection });
    setState({ inboxFilter, selection, dispatchBrief: state.dispatchBrief?.chatId === eligibleId ? state.dispatchBrief : null });
  }
  return {
    onInboxFilter: (filter) => {
      const state = getState();
      if (filter === state.inboxFilter || !['all', 'review', 'lower_concern'].includes(filter)) return;
      setSelection(state, pruneSelection(state.selection, state.chats, filter), filter);
    },
    onSelectAll: (selected) => {
      const state = getState();
      if (state.pending !== null || !state.inboxLoaded) return;
      setSelection(state, selected ? selectableChatIds(state.chats, state.inboxFilter) : new Set());
    },
    onToggleSelect: (chatId, selected) => {
      const state = getState();
      setSelection(state, toggleSelection(state.selection, chatId, selected));
    },
    onDispatchBriefInput: (text, clear) => {
      const chatId = briefingChatId(getState());
      if (chatId !== null) setState({ dispatchBrief: { chatId, text, clear } });
    },
    onDispatch: async () => {
      const review = await run(ctx, 'dispatch', () => dispatchSelected(ctx));
      if (review && !ctx.listeners.signal.aborted) ctx.openQueuedDispatch(review.timeline, review.officerContext);
    },
    onDispatchCurrent: (officerContext, expectedChatId, permission) => dispatchCurrent(ctx, officerContext, expectedChatId, permission),
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
