/** Navigation and controls shared by the inbox and the currently open conversation. */
import { chatHref } from '../state/route.js';
import { dispatchReason, formatCompactTime, formatTime } from '../format.js';
import { telegramDispatchRequest } from '../state/inbox.js';
import { latestIncomingMessageId, timelineForPeriod } from '../state/timeline.js';

/** From this width the evidence panel sits beside the conversation. Below it the panel covers part of the conversation. */
export const DOCKED_EVIDENCE = '(min-width: 1181px)';
const BOTTOM_SLACK_PX = 40;

const REPEAT_ACTIONS = {
  answered: ['Send follow-up', 'Ali will write a new follow-up using this conversation.'],
  left_unanswered: ['Reverse Leave unanswered', 'Requesting a reply reverses the earlier Leave unanswered decision for this message.'],
  skipped: ['Send reply', 'Ali skipped this message before. Dispatch requests a reply now.'],
  failed: ['Retry reply', 'The earlier attempt failed. Check the conversation for delivery before retrying.'],
  reviewed: ['Reply after review', 'This asks Ali to respond to the message previously sent for review.'],
};

/**
 * What confirming Dispatch does, said before the officer confirms. In a live Telegram chat it can send a real reply at
 * once, so that leads; a hold, an opt-out or the account-wide switch changes the outcome and is named instead.
 */
function dispatchEffect(chat, view, repliesMode) {
  const hold = chat.telegramReplyHold;
  if (!view.live) {
    return { tone: 'quiet', title: 'Dispatch starts AI review', text: 'The messages captured in this chat are queued for review. Nothing is sent to the contact.' };
  }
  if (hold.contactOptedOut) return { tone: 'blocked', title: 'No reply will be sent', text: 'This participant opted out. Automated replies are on hold.' };
  if (repliesMode === 'off') return { tone: 'blocked', title: 'No reply will be sent now', text: 'Account-wide replies are off. Turn them on for future eligible DMs.' };
  if (view.blocked) return { tone: 'blocked', title: 'No reply can be queued now', text: dispatchReason(view.blocked) };
  if (view.repeat && hold.officerReview === null) {
    return { tone: 'live', title: REPEAT_ACTIONS[view.repeat][0], text: REPEAT_ACTIONS[view.repeat][1] };
  }
  return {
    tone: hold.officerReview === null ? 'live' : 'held',
    title: hold.officerReview === null ? 'Dispatch requests a reply now' : 'Bank details need your review',
    text: 'Dispatch asks Ali to answer the latest eligible DM now and keep answering new messages automatically. Pause AI or Take over stops him.',
  };
}

function drawDispatchEffect(refs, chat, view, repliesMode) {
  const effect = dispatchEffect(chat, view, repliesMode);
  refs.chatDispatchConsequence.dataset.tone = effect.tone;
  refs.chatDispatchEffectTitle.textContent = effect.title;
  refs.chatDispatchEligibility.textContent = effect.text;
}

/** The incoming message a live Dispatch would look at, by its time only: its text stays in the conversation. */
function latestIncomingNote(timeline) {
  const current = timelineForPeriod(timeline, false);
  const latest = current.messages.find((message) => message.id === latestIncomingMessageId(current));
  return latest ? `Latest incoming message: received ${formatCompactTime(latest.receivedAt)}.` : 'No incoming message in this chat yet.';
}

/** The timeline's reading position: at the newest message, or the first entry in view and where its top sits. */
function readPlace(timeline) {
  if (timeline.offsetParent === null) return null;
  if (timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < BOTTOM_SLACK_PX) return { atBottom: true };
  const top = timeline.getBoundingClientRect().top;
  for (const entry of timeline.children) {
    const rect = entry.getBoundingClientRect();
    if (rect.bottom > top) return { atBottom: false, entry, offset: rect.top - top };
  }
  return null;
}

/** Puts the same entry back where it was after the conversation changed width. */
function restorePlace(timeline, place) {
  if (place === null || timeline.offsetParent === null) return;
  if (place.atBottom) timeline.scrollTop = timeline.scrollHeight;
  else if (place.entry.isConnected) timeline.scrollTop += place.entry.getBoundingClientRect().top - timeline.getBoundingClientRect().top - place.offset;
}

export function resetCaseTools(refs) {
  if (refs.chatDispatchDialog.open) refs.chatDispatchDialog.close();
  refs.chatDispatchForm.reset();
  refs.chatDispatchContext.disabled = false;
  refs.chatDispatchStatus.textContent = '';
  refs.chatDispatchTarget.textContent = '';
  refs.addConfirmation.open = false;
  refs.sidePanel.scrollTop = 0;
}

export function renderWorkspace(refs, state) {
  const chat = state.timeline?.chat;
  const selected = state.selectedChatId !== null;
  // Opening or closing evidence beside the conversation changes its width; keep the officer at the same message.
  const evidenceChanged = refs.inboxView.dataset.evidenceOpen !== String(state.evidenceOpen);
  const place = evidenceChanged ? readPlace(refs.timeline) : null;
  refs.inboxView.dataset.chatOpen = String(selected);
  refs.inboxView.dataset.evidenceOpen = String(state.evidenceOpen);
  refs.chatTools.hidden = !selected;
  refs.openEvidence.disabled = !chat;
  refs.openEvidence.setAttribute('aria-expanded', String(state.evidenceOpen));
  refs.sidePanel.hidden = !state.evidenceOpen;
  if (evidenceChanged) restorePlace(refs.timeline, place);
  refs.openChatDispatch.hidden = state.previous || !chat || !['not_started', 'ai_active'].includes(chat.aiMode) || chat.source === 'citizen_report';
  refs.archiveNotice.hidden = !state.previous;
  refs.previousConversationSection.hidden = !state.timeline?.testSession || state.previous;
  refs.addConfirmation.hidden = state.previous;
  if (chat) {
    refs.currentConversation.href = chatHref(chat.id);
    refs.previousConversation.href = chatHref(chat.id) + '/previous';
  }
  const replies = state.timeline?.telegramReplies;
  const queued = replies?.request?.status === 'queued' && replies.request.kind !== 'consent_notice' && replies.request.messageId === replies.target?.messageId;
  const repeat = REPEAT_ACTIONS[replies?.target?.state];
  if (queued) refs.openChatDispatch.textContent = 'Reply queued';
  else refs.openChatDispatch.textContent = repeat && !replies.blocked ? repeat[0] : 'Dispatch this chat';
  refs.openChatDispatch.disabled = state.pending !== null || queued;
  if (replies || (chat?.source === 'telegram' && state.timeline.messages.some(message => message.source.captureMethod === 'telegram_business_live'))) refs.openChatDispatch.removeAttribute('aria-haspopup');
  else refs.openChatDispatch.setAttribute('aria-haspopup', 'dialog');
  refs.resetThisChat.disabled = !chat || state.pending !== null;
  // A suspect's header says so instead; clearing the number on the watchlist brings the button back.
  refs.openFlagScammer.hidden = !chat || state.previous || Boolean(chat.suspect);
  refs.openFlagScammer.disabled = state.pending !== null;
  refs.eraseInbox.disabled = state.pending !== null;
  refs.replyPrompt.hidden = !state.consentPrompt?.available;
  refs.reloadReplyPrompt.disabled = state.pending !== null;
  refs.reloadReplyPrompt.setAttribute('aria-busy', String(state.pending === 'reload_reply_prompt'));
  if (state.pending === 'reload_reply_prompt') refs.settingsStatus.textContent = 'Loading the saved prompt…';
  const liveBriefing = refs.chatDispatchForm.dataset.live === 'true';
  refs.confirmChatDispatch.disabled = state.pending !== null || refs.openChatDispatch.hidden
    || (liveBriefing && chat?.telegramReplyHold.contactOptedOut);
  if (chat && refs.chatDispatchDialog.open && liveBriefing) {
    drawDispatchEffect(refs, chat, { live: true, repeat: refs.chatDispatchForm.dataset.repeat, blocked: replies?.blocked }, state.dmReplies?.mode);
  }
  refs.settingsUnavailable.hidden = !refs.dmReplies.hidden || !refs.testMode.hidden;
  refs.settingsUnavailable.textContent = state.dmReplies === null && state.consentPrompt === null
    ? 'Telegram settings are unavailable or still loading.' : 'No Telegram reply settings are available for this account.';
}

export function bindWorkspace(ctx) {
  const { refs, handlers } = ctx;
  const options = { signal: ctx.listeners.signal };
  refs.inboxFilterAll.addEventListener('click', () => handlers.onInboxFilter('all'), options);
  refs.inboxFilterNew.addEventListener('click', () => handlers.onInboxFilter('new_messages'), options);
  refs.inboxFilterSuspects.addEventListener('click', () => handlers.onInboxFilter('suspects'), options);
  refs.inboxFilterReports.addEventListener('click', () => handlers.onInboxFilter('citizen_reports'), options);
  refs.inboxFilterReview.addEventListener('click', () => handlers.onInboxFilter('review'), options);
  refs.inboxFilterLowerConcern.addEventListener('click', () => handlers.onInboxFilter('lower_concern'), options);
  refs.openSettings.addEventListener('click', () => {
    if (ctx.getState().pending !== 'reload_reply_prompt') refs.settingsStatus.textContent = '';
    refs.settingsDialog.showModal();
  }, options);
  for (const [button, action] of [
    [refs.dmRepliesSwitch, handlers.onSetDmReplies], [refs.testModeSwitch, handlers.onSetTestMode],
    [refs.reloadReplyPrompt, handlers.onReloadReplyPrompt],
  ]) {
    button.addEventListener('click', async () => {
      await action();
      if (!ctx.listeners.signal.aborted && refs.settingsDialog.open) {
        refs.settingsStatus.textContent = ctx.getState().notice?.text ?? '';
      }
    }, options);
  }
  const closeEvidence = () => {
    ctx.setState({ evidenceOpen: false });
    refs.openEvidence.focus({ preventScroll: true });
  };
  const openEvidence = () => {
    if (ctx.getState().timeline === null) return;
    ctx.setState({ evidenceOpen: true });
    refs.closeEvidence.focus({ preventScroll: true });
  };
  refs.openEvidence.addEventListener('click', () => {
    if (ctx.getState().evidenceOpen) closeEvidence();
    else openEvidence();
  }, options);
  // A signal in the conversation header (a watchlist match) leads to its details in the evidence panel.
  handlers.onShowEvidence = openEvidence;
  refs.closeEvidence.addEventListener('click', closeEvidence, options);
  refs.sidePanel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) closeEvidence();
  }, options);
  refs.sidePanel.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#/chats/"]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    // Beside the conversation the panel stays open while the officer follows its sources; where it covers the
    // conversation it closes, so the message it points to can be seen.
    if (!window.matchMedia(DOCKED_EVIDENCE).matches) closeEvidence();
    if (link.hash === window.location.hash) {
      const message = refs.timeline.querySelector('.focused');
      message?.scrollIntoView({ block: 'center' });
      message?.focus({ preventScroll: true });
    }
  }, options);
  // The newest message stays in view when the timeline's height changes under it: the composer opening after a
  // takeover, a notice appearing, the header growing or shrinking.
  let pinned = true;
  const atBottom = () => refs.timeline.scrollHeight - refs.timeline.scrollTop - refs.timeline.clientHeight < BOTTOM_SLACK_PX;
  refs.timeline.addEventListener('scroll', () => { pinned = atBottom(); }, { ...options, passive: true });
  const resized = new ResizeObserver(() => {
    if (pinned) refs.timeline.scrollTop = refs.timeline.scrollHeight;
  });
  resized.observe(refs.timeline);
  options.signal.addEventListener('abort', () => resized.disconnect(), { once: true });
  bindChatDispatch(ctx, options);
}

function bindChatDispatch(ctx, options) {
  const { refs } = ctx;
  let session = null;
  const current = view => session === view && refs.chatDispatchDialog.open
    && !ctx.listeners.signal.aborted && ctx.getState().selectedChatId === view.chatId;

  ctx.beginChatDispatch = (timeline, briefing, { editBriefing = false } = {}) => {
    if (!timeline || ctx.getState().pending !== null || ctx.getState().selectedChatId !== timeline.chat.id) return;
    const chat = timeline.chat;
    const replies = timeline.telegramReplies;
    const live = !!replies || (chat.source === 'telegram' && timeline.messages.some(message => message.source.captureMethod === 'telegram_business_live'));
    const target = replies?.target;
    const repeat = !replies?.blocked && Object.hasOwn(REPEAT_ACTIONS, target?.state) ? target.state : null;
    if (live && !editBriefing) {
      void ctx.handlers.onDispatchCurrent(briefing, chat.id, telegramDispatchRequest(target));
      return;
    }
    const view = { chatId: chat.id, live, repeat, target, blocked: replies?.blocked };
    session = view;
    refs.chatDispatchTarget.textContent = chat.displayLabel;
    refs.chatDispatchForm.reset();
    refs.chatDispatchForm.dataset.live = String(live);
    refs.chatDispatchForm.dataset.repeat = repeat ?? '';
    refs.confirmChatDispatch.textContent = repeat ? REPEAT_ACTIONS[repeat][0] : 'Dispatch';
    refs.confirmChatDispatch.disabled = live && chat.telegramReplyHold.contactOptedOut;
    // The confirm button is described by what confirming does.
    if (live) refs.confirmChatDispatch.setAttribute('aria-describedby', 'chat-dispatch-eligibility');
    else refs.confirmChatDispatch.removeAttribute('aria-describedby');
    refs.chatDispatchBriefFields.hidden = chat.source !== 'telegram';
    refs.chatDispatchStatus.textContent = '';
    refs.chatDispatchContext.value = briefing ?? '';
    refs.chatDispatchClear.checked = briefing === null;
    refs.chatDispatchContext.disabled = briefing === null;
    refs.chatDispatchMode.textContent = 'Participant permission';
    drawDispatchEffect(refs, chat, view, ctx.getState().dmReplies?.mode);
    refs.chatDispatchLatest.textContent = live ? latestIncomingNote(timeline) : '';
    const record = timeline.caseActions.findLast(action => action.type === 'telegram_dispatch_permission_recorded' || action.type === 'telegram_dispatch_approved');
    refs.chatDispatchRecord.hidden = !record;
    refs.chatDispatchRecord.textContent = record ? 'An officer confirmed participant permission on ' + formatTime(record.occurredAt) + '.' : '';
    // A live Telegram chat shows this section only to say when permission was confirmed.
    refs.chatDispatchPermissionSection.hidden = !(live && record);
    refs.chatDispatchDialog.showModal();
  };
  refs.openChatDispatch.addEventListener('click', event => {
    if (event.detail < 2) ctx.beginChatDispatch(ctx.getState().timeline);
  }, options);
  ctx.handlers.onDispatchWithBrief = () => ctx.beginChatDispatch(ctx.getState().timeline, undefined, { editBriefing: true });
  refs.chatDispatchClear.addEventListener('change', () => {
    refs.chatDispatchContext.disabled = refs.chatDispatchClear.checked;
  }, options);
  refs.cancelChatDispatch.addEventListener('click', () => refs.chatDispatchDialog.close(), options);
  refs.chatDispatchForm.addEventListener('submit', async event => {
    event.preventDefault();
    const view = session;
    if (!view || !current(view) || refs.confirmChatDispatch.disabled) return;
    const latest = ctx.getState().timeline.telegramReplies?.target;
    if (view.target && (latest?.messageId !== view.target.messageId || latest?.headPosition !== view.target.headPosition)) {
      refs.chatDispatchDialog.close();
      ctx.setState({ notice: { tone: 'info', text: dispatchReason('target_changed') } });
      return;
    }
    const permission = view.live ? telegramDispatchRequest(view.target) : undefined;
    let context;
    if (ctx.getState().timeline?.chat.source === 'telegram') {
      context = refs.chatDispatchClear.checked ? null : refs.chatDispatchContext.value.trim() || undefined;
    }
    const success = await ctx.handlers.onDispatchCurrent(context, view.chatId, permission);
    if (!current(view)) return;
    if (success) refs.chatDispatchDialog.close();
    else {
      refs.chatDispatchStatus.textContent = ctx.getState().notice?.text ?? 'Dispatch is unavailable for this conversation.';
    }
  }, options);
}
