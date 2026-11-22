/**
 * Region-by-region redraws. Each region is drawn again only when one of its inputs changed (compared by reference), so
 * typing in the composer does not rebuild the timeline and its capture images.
 */
import { renderChatHeader } from './views/chat-header.js';
import { renderComposer } from './views/composer.js';
import { renderInbox } from './views/inbox.js';
import { renderSidePanel } from './views/side-panel.js';
import { renderTimeline } from './views/timeline.js';

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

function renderShell(refs, state) {
  refs.notice.textContent = state.notice === null ? '' : state.notice.text;
  refs.notice.classList.toggle('notice-error', state.notice !== null && state.notice.tone === 'error');
  refs.inboxView.hidden = state.view !== 'inbox';
  refs.watchlistView.hidden = state.view !== 'watchlist';
  setCurrent(refs.navInbox, state.view === 'inbox');
  setCurrent(refs.navWatchlist, state.view === 'watchlist');
  refs.connection.textContent = CONNECTION_LABELS[state.connection] ?? '';
}

export function createRenderer({ refs, handlers, captures, watchlistView }) {
  const regions = [
    region((s) => renderInbox(refs, s, handlers), (s) => [s.chats, s.chatsTotal, s.inboxLoaded, s.selection, s.selectedChatId, s.pending]),
    region((s) => renderChatHeader(refs.chatHeader, s, handlers), (s) => [s.timeline, s.timelineError, s.selectedChatId, s.pending]),
    region((s) => renderTimeline(refs.timeline, s, handlers, captures), (s) => [s.timeline, s.replyTargetId, s.focusMessageId]),
    region((s) => renderComposer(refs, s), (s) => [s.timeline, s.composer, s.replyTargetId, s.pending]),
    region((s) => renderSidePanel(refs, s), (s) => [s.timeline]),
    region((s) => watchlistView.render(s, handlers), (s) => [s.watchlist, s.pending]),
    region((s) => renderShell(refs, s), (s) => [s.notice, s.view, s.connection]),
  ];
  return (state) => {
    for (const draw of regions) draw(state);
  };
}
