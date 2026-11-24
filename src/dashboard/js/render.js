/**
 * Region-by-region redraws. Each region is drawn again only when one of its inputs changed (compared by reference), so
 * typing in the composer does not rebuild the timeline and its capture images.
 */
import { renderChatHeader } from './views/chat-header.js';
import { renderComposer } from './views/composer.js';
import { renderDispatchTools, renderInbox } from './views/inbox.js';
import { renderCaseReferenceForm, renderSidePanel } from './views/side-panel.js';
import { renderTimeline } from './views/timeline.js';
import { renderWorkspace } from './views/workspace.js';
import { timelineForPeriod } from './state/timeline.js';

const CONNECTION_LABELS = {
  connecting: 'Connecting to live updates',
  live: 'Live updates on',
  reconnecting: 'Reconnecting to live updates',
};

function region(draw, inputsOf) {
  let last = null;
  return (state) => {
    const inputs = inputsOf(state);
    if (last !== null && inputs.every((value, index) => value === last[index])) return;
    last = inputs;
    draw(state);
  };
}

function setCurrent(link, current) {
  if (current) link.setAttribute('aria-current', 'page');
  else link.removeAttribute('aria-current');
}

function renderSwitch(button, enabled, pending) {
  button.disabled = pending !== null;
  button.textContent = enabled ? 'On' : 'Off';
  button.setAttribute('aria-checked', String(enabled));
}

function renderDmReplies(refs, state) {
  const setting = state.dmReplies;
  refs.dmReplies.hidden = !setting?.available && !setting?.enabled;
  if (refs.dmReplies.hidden) return;
  renderSwitch(refs.dmRepliesSwitch, setting.enabled, state.pending);
  const hints = {
    approved: 'Ali currently replies only to approved chats.',
    all_private: 'Ali can reply in chats with recorded consent.',
    off: 'Automatic replies are paused. Incoming DMs still appear in the inbox.',
  };
  refs.dmRepliesHint.textContent = setting.available ? hints[setting.mode] : 'Telegram replies are offline. Turn this off to keep them paused after reconnection.';
}

function renderTestMode(refs, state) {
  const setting = state.consentPrompt;
  refs.testMode.hidden = !setting?.available;
  if (refs.testMode.hidden) return;
  // The saved preference controls invitations. Test mode is on when invitations are off.
  const testModeOn = !setting.enabled;
  renderSwitch(refs.testModeSwitch, testModeOn, state.pending);
  refs.testModeHint.textContent = testModeOn
    ? 'With all-DM replies on, a new chat becomes AI active whether you or the contact sends the first message. Ali waits for an incoming DM and recorded permission before replying. Consent invitations are off.'
    : 'With all-DM replies on, new chats wait for manual Dispatch. New contacts can receive a consent invitation. Ali can continue replying in active chats with recorded permission.';
}

function renderShell(refs, state) {
  refs.notice.textContent = state.notice === null ? '' : state.notice.text;
  refs.notice.classList.toggle('notice-error', state.notice !== null && state.notice.tone === 'error');
  refs.inboxView.hidden = state.view !== 'inbox';
  refs.watchlistView.hidden = state.view !== 'watchlist';
  setCurrent(refs.navInbox, state.view === 'inbox');
  setCurrent(refs.navWatchlist, state.view === 'watchlist');
  refs.connection.textContent = CONNECTION_LABELS[state.connection] ?? '';
  // The stylesheet colours the status dot from this: green when live, amber while connecting.
  refs.connection.dataset.state = state.connection ?? '';
}

export function createRenderer({ refs, handlers, captures, watchlistView }) {
  const regions = [
    region((s) => renderDmReplies(refs, s), (s) => [s.dmReplies, s.pending]),
    region((s) => renderTestMode(refs, s), (s) => [s.consentPrompt, s.pending]),
    region((s) => renderInbox(refs, s, handlers), (s) => [s.chats, s.chatsTotal, s.inboxLoaded, s.inboxFilter, s.selection, s.selectedChatId, s.pending]),
    region((s) => renderDispatchTools(refs, s), (s) => [s.chats, s.selection, s.dispatchBrief, s.pending]),
    region((s) => renderChatHeader(refs.chatHeader, s, handlers), (s) => [s.timeline, s.timelineError, s.selectedChatId, s.pending, s.previous]),
    region((s) => renderTimeline(refs.timeline, s, handlers, captures), (s) => [s.timeline, s.replyTargetId, s.focusMessageId, s.focusEventId]),
    region((s) => renderComposer(refs, s), (s) => [s.timeline, s.composer, s.replyTargetId, s.pending]),
    region((s) => renderSidePanel(refs, s), (s) => [s.timeline]),
    region((s) => renderCaseReferenceForm(refs, s), (s) => [s.timeline, s.caseReferenceDraft, s.pending]),
    region((s) => watchlistView.render(s, handlers), (s) => [s.watchlist, s.pending]),
    region((s) => renderShell(refs, s), (s) => [s.notice, s.view, s.connection]),
    region((s) => renderWorkspace(refs, s), (s) => [s.selectedChatId, s.timeline, s.evidenceOpen, s.pending, s.dmReplies, s.consentPrompt, s.notice, s.previous]),
  ];
  let whole, period, previous;
  return (state) => {
    const test = state.timeline?.testSession;
    const archive = Boolean(test && (state.previousRequested || test.previousMessageIds.includes(state.focusMessageId)));
    if (whole !== state.timeline || previous !== archive) {
      whole = state.timeline;
      previous = archive;
      period = whole ? timelineForPeriod(whole, archive) : null;
    }
    const visible = { ...state, timeline: period, wholeTimeline: whole, previous };
    for (const draw of regions) draw(visible);
  };
}
