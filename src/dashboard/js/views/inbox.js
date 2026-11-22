/** The inbox: the New inbound queue on top, then the open chats, each with a checkbox for Dispatch. */
import { bdi, clear, h, withFocus } from '../dom.js';
import { AI_MODE_LABELS } from '../format.js';
import { groupInbox } from '../state/inbox.js';
import { chatHref } from '../state/route.js';
import { matchBadge } from './matches.js';

const REVIEW_NOTES = { active: 'Review in progress', unavailable: 'Review unavailable' };

/** The checkbox names itself from the chat label, so every assistive tool announces which chat it selects. */
function selector(chat, state, handlers) {
  const checkbox = h('input', {
    type: 'checkbox',
    'aria-label': `Select ${chat.displayLabel}`,
    checked: state.selection.has(chat.id),
    dataset: { focusKey: `select:${chat.id}` },
  });
  checkbox.addEventListener('change', () => handlers.onToggleSelect(chat.id, checkbox.checked));
  return h('label', { className: 'select-chat' }, [checkbox]);
}

function chatItem(chat, state, handlers) {
  const current = chat.id === state.selectedChatId;
  const link = h('a', { href: chatHref(chat.id), className: 'chat-link', 'aria-current': current ? 'page' : null, dataset: { focusKey: `open:${chat.id}` } }, [
    bdi(chat.displayLabel),
  ]);
  const meta = h('p', { className: 'chat-meta' }, [
    h('span', { className: 'badge', text: chat.channelLabel }),
    h('span', { text: chat.originLabel }),
    h('span', { className: `ai-mode mode-${chat.aiMode}`, text: AI_MODE_LABELS[chat.aiMode] ?? chat.aiMode }),
    REVIEW_NOTES[chat.review.state]
      ? h('span', { className: `review-note review-note-${chat.review.state}`, text: REVIEW_NOTES[chat.review.state] })
      : null,
  ]);
  const body = h('div', { className: 'chat-item-body' }, [link, meta, matchBadge(chat)]);
  return h('li', { className: current ? 'chat-item current' : 'chat-item', dataset: { chatId: chat.id } }, [selector(chat, state, handlers), body]);
}

function fillList(list, chats, state, handlers, emptyText) {
  clear(list);
  if (chats.length === 0) list.append(h('li', { className: 'empty', text: emptyText }));
  for (const chat of chats) list.append(chatItem(chat, state, handlers));
}

export function renderInbox(refs, state, handlers) {
  const { newInbound, open } = groupInbox(state.chats);
  withFocus(refs.inbox, () => {
    fillList(refs.newInboundList, newInbound, state, handlers, state.inboxLoaded ? 'No chats waiting.' : 'Loading…');
    fillList(refs.openList, open, state, handlers, state.inboxLoaded ? 'No open chats.' : 'Loading…');
  });
  const selected = state.selection.size;
  refs.dispatchButton.disabled = selected === 0 || state.pending !== null;
  const hidden = state.chatsTotal > state.chats.length ? ` Showing ${state.chats.length} of ${state.chatsTotal} chats.` : '';
  refs.selectionCount.textContent = (selected === 0 ? 'Select chats to dispatch.' : `${selected} selected.`) + hidden;
}
