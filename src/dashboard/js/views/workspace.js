/** Navigation and controls shared by the inbox and the currently open conversation. */
import { chatHref } from '../state/route.js';
import { describeError, formatTime } from '../format.js';

function liveDispatchBlocked(mode, chat) {
  return mode === 'unavailable' || (Boolean(mode) && chat?.telegramReplyHold.contactOptedOut);
}

function dispatchEligibility(hold, repliesMode) {
  if (hold.contactOptedOut) return 'This participant opted out. Automated replies are on hold.';
  if (repliesMode === 'off') return 'Account-wide replies are off. Turn them on for future eligible DMs.';
  return 'Confirming Dispatch asks Ali to answer the latest eligible unanswered DM now. Officer holds and Telegram’s reply window still apply.';
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
  refs.inboxView.dataset.chatOpen = String(selected);
  refs.inboxView.dataset.evidenceOpen = String(state.evidenceOpen);
  refs.chatTools.hidden = !selected;
  refs.openEvidence.disabled = !chat;
  refs.openEvidence.setAttribute('aria-expanded', String(state.evidenceOpen));
  refs.sidePanel.hidden = !state.evidenceOpen;
  refs.openChatDispatch.hidden = state.previous || !chat || !['not_started', 'ai_active'].includes(chat.aiMode);
  refs.archiveNotice.hidden = !state.previous;
  refs.previousConversationSection.hidden = !state.timeline?.testSession || state.previous;
  refs.addConfirmation.hidden = state.previous;
  if (chat) {
    refs.currentConversation.href = chatHref(chat.id);
    refs.previousConversation.href = chatHref(chat.id) + '/previous';
  }
  refs.openChatDispatch.disabled = state.pending !== null;
  refs.resetThisChat.disabled = !chat || state.pending !== null;
  refs.eraseInbox.disabled = state.pending !== null;
  refs.replyPrompt.hidden = !state.consentPrompt?.available;
  refs.reloadReplyPrompt.disabled = state.pending !== null;
  refs.reloadReplyPrompt.setAttribute('aria-busy', String(state.pending === 'reload_reply_prompt'));
  if (state.pending === 'reload_reply_prompt') refs.settingsStatus.textContent = 'Loading the saved prompt…';
  refs.confirmChatDispatch.disabled = state.pending !== null || refs.openChatDispatch.hidden
    || refs.chatDispatchForm.dataset.checking === 'true'
    || liveDispatchBlocked(refs.chatDispatchForm.dataset.mode, chat);
  if (chat && refs.chatDispatchDialog.open && refs.chatDispatchForm.dataset.mode) {
    refs.chatDispatchEligibility.textContent = dispatchEligibility(chat.telegramReplyHold, state.dmReplies?.mode);
  }
  refs.settingsUnavailable.hidden = !refs.dmReplies.hidden || !refs.testMode.hidden;
  refs.settingsUnavailable.textContent = state.dmReplies === null && state.consentPrompt === null
    ? 'Telegram settings are unavailable or still loading.' : 'No Telegram reply settings are available for this account.';
}

export function bindWorkspace(ctx) {
  const { refs, handlers } = ctx;
  const options = { signal: ctx.listeners.signal };
  refs.inboxFilterAll.addEventListener('click', () => handlers.onInboxFilter('all'), options);
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
  refs.openEvidence.addEventListener('click', () => {
    if (ctx.getState().evidenceOpen) return closeEvidence();
    ctx.setState({ evidenceOpen: true });
    refs.closeEvidence.focus({ preventScroll: true });
  }, options);
  refs.closeEvidence.addEventListener('click', closeEvidence, options);
  refs.sidePanel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) closeEvidence();
  }, options);
  refs.sidePanel.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#/chats/"]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    closeEvidence();
    if (link.hash === window.location.hash) {
      const message = refs.timeline.querySelector('.focused');
      message?.scrollIntoView({ block: 'center' });
      message?.focus({ preventScroll: true });
    }
  }, options);
  bindChatDispatch(ctx, options);
}

function bindChatDispatch(ctx, options) {
  const { refs } = ctx;
  let session = null;
  const current = view => session === view && refs.chatDispatchDialog.open
    && !ctx.listeners.signal.aborted && ctx.getState().selectedChatId === view.chatId;

  function checking(busy) {
    refs.chatDispatchForm.dataset.checking = String(busy);
    const state = ctx.getState();
    refs.confirmChatDispatch.disabled = busy || state.pending !== null || refs.openChatDispatch.hidden
      || liveDispatchBlocked(session?.mode, state.timeline?.chat);
  }

  async function readMode(view) {
    checking(true);
    try {
      const [invite, replies] = await Promise.all([ctx.api.consentPrompt(), ctx.api.dmReplies()]);
      if (!current(view)) return false;
      const mode = !invite.available ? 'unavailable' : invite.enabled ? 'normal' : 'test';
      const previous = view.mode;
      view.mode = mode;
      refs.chatDispatchForm.dataset.mode = mode;
      const test = mode === 'test';
      const holds = ctx.getState().timeline.chat.telegramReplyHold;
      refs.chatDispatchMode.textContent = test ? 'Test mode on' : mode === 'normal' ? 'Test mode off' : 'Telegram replies';
      refs.confirmChatDispatch.textContent = test ? 'Dispatch test chat' : 'Dispatch';
      refs.chatDispatchModeHint.textContent = mode === 'unavailable' ? 'Dispatch requires access to the linked Telegram account.'
        : 'Choosing ' + refs.confirmChatDispatch.textContent + ' confirms this is your own account or the participant has already agreed to AI replies and fraud screening, including sending their messages to Gemini through OpenRouter when configured.';
      refs.chatDispatchEligibility.textContent = dispatchEligibility(holds, replies.mode);
      checking(false);
      if (previous !== null && previous !== mode) {
        refs.chatDispatchStatus.textContent = 'The Test mode setting changed. Review the updated mode before dispatching.';
        return false;
      }
      return true;
    } catch (error) {
      if (current(view)) refs.chatDispatchStatus.textContent = describeError(error) + ' Close and reopen Dispatch to check the current settings.';
      return false;
    }
  }

  refs.openChatDispatch.addEventListener('click', () => {
    const timeline = ctx.getState().timeline;
    if (!timeline) return;
    const chat = timeline.chat;
    const live = chat.source === 'telegram' && timeline.messages.some(message => message.source.captureMethod === 'telegram_business_live');
    const view = { chatId: chat.id, live, mode: null };
    session = view;
    refs.chatDispatchTarget.textContent = chat.displayLabel;
    refs.chatDispatchForm.reset();
    refs.chatDispatchForm.dataset.mode = '';
    refs.confirmChatDispatch.textContent = 'Dispatch';
    refs.chatDispatchBriefFields.hidden = chat.source !== 'telegram';
    refs.chatDispatchStatus.textContent = '';
    refs.chatDispatchContext.disabled = false;
    refs.chatDispatchPermissionSection.hidden = !live;
    refs.chatDispatchMode.textContent = 'Checking Telegram settings…';
    refs.chatDispatchModeHint.textContent = '';
    refs.chatDispatchEligibility.textContent = '';
    const record = timeline.caseActions.filter(action => action.type === 'telegram_dispatch_permission_recorded').at(-1);
    refs.chatDispatchRecord.hidden = !record;
    refs.chatDispatchRecord.textContent = record ? 'An officer recorded participant permission on ' + formatTime(record.occurredAt) + '.' : '';
    checking(live);
    refs.chatDispatchDialog.showModal();
    if (live) void readMode(view);
  }, options);
  refs.chatDispatchClear.addEventListener('change', () => {
    refs.chatDispatchContext.disabled = refs.chatDispatchClear.checked;
  }, options);
  refs.cancelChatDispatch.addEventListener('click', () => refs.chatDispatchDialog.close(), options);
  refs.chatDispatchForm.addEventListener('submit', async event => {
    event.preventDefault();
    const view = session;
    if (!view || !current(view) || refs.confirmChatDispatch.disabled) return;
    if (view.live && !(await readMode(view))) return;
    if (!current(view) || refs.confirmChatDispatch.disabled) return;
    let permission;
    if (view.mode === 'test') permission = { participantPermissionRecorded: true, expectedTestMode: true };
    else if (view.mode === 'normal') permission = { participantPermissionRecorded: true };
    let context;
    if (ctx.getState().timeline?.chat.source === 'telegram') {
      context = refs.chatDispatchClear.checked ? null : refs.chatDispatchContext.value.trim() || undefined;
    }
    const success = await ctx.handlers.onDispatchCurrent(context, view.chatId, permission, view.live);
    if (!current(view)) return;
    if (success) refs.chatDispatchDialog.close();
    else {
      refs.chatDispatchStatus.textContent = ctx.getState().notice?.text ?? 'Dispatch is unavailable for this conversation.';
      if (view.live) await readMode(view);
    }
  }, options);
}
