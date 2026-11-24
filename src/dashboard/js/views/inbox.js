/** The inbox: the New inbound queue on top, then the open chats, each with a checkbox for Dispatch. */
import { bdi, clear, h, withFocus } from '../dom.js';
import { AI_MODE_LABELS, evidenceCountLabel, evidenceItemsFor, formatTime } from '../format.js';
import { briefingChatId, groupInbox, needsOfficerReview } from '../state/inbox.js';
import { chatHref } from '../state/route.js';

/** The checkbox names itself from the chat label, so every assistive tool announces which chat it selects. */
function selector(chat, state, handlers) {
  const checkbox = h('input', {
    type: 'checkbox',
    'aria-label': `Select ${chat.displayLabel}`,
    checked: state.selection.has(chat.id),
    disabled: state.pending !== null,
    dataset: { focusKey: `select:${chat.id}` },
  });
  checkbox.addEventListener('change', () => handlers.onToggleSelect(chat.id, checkbox.checked));
  return h('label', { className: 'select-chat' }, [checkbox]);
}

const shortDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function activityTime(iso, today) {
  const fullTime = formatTime(iso);
  const text = iso.startsWith(today) ? iso.slice(11, 16) : shortDate.format(new Date(iso));
  return h('time', { className: 'chat-activity', datetime: iso, title: fullTime, 'aria-label': `Last activity ${fullTime}`, text });
}

function chatItem(chat, state, handlers, today) {
  const current = chat.id === state.selectedChatId;
  const evidence = evidenceItemsFor(chat.telegramReplyHold);
  const hasPaymentFlag = evidence.some(item => item.reason === 'model_payment_link');
  const link = h('a', { href: chatHref(chat.id), className: 'chat-link', 'aria-current': current ? 'page' : null, dataset: { focusKey: `open:${chat.id}` } }, [
    bdi(chat.displayLabel),
  ]);
  const heading = h('div', { className: 'chat-item-heading' }, [link, activityTime(chat.lastActivityAt, today)]);
  const repliesHeld = chat.aiMode === 'ai_active' && needsOfficerReview(chat);
  const meta = h('p', { className: 'chat-meta' }, [
    h('span', { className: 'badge', text: chat.channelLabel }),
    repliesHeld ? h('span', { className: 'flag', text: 'Replies held' })
      : h('span', { className: `ai-mode mode-${chat.aiMode}`, text: AI_MODE_LABELS[chat.aiMode] ?? chat.aiMode }),
    chat.telegramReplyHold.contactOptedOut ? h('span', { className: 'flag', text: 'Contact opted out' }) : null,
    hasPaymentFlag ? h('span', { className: 'payment-review-flag', text: 'Payment link needs review' }) : null,
    chat.lowerConcern ? h('span', { className: 'lower-concern-badge', text: 'Lower concern' }) : null,
    evidence.length > 0 && !hasPaymentFlag ? h('span', { className: 'flag', text: evidenceCountLabel(evidence.length) }) : null,
    chat.watchlistMatches.length ? h('span', { className: 'badge badge-match', text: 'Watchlist match' }) : null,
    chat.review.state === 'unavailable' ? h('span', { className: 'review-note-unavailable', text: 'Review unavailable' }) : null,
  ]);
  const body = h('div', { className: 'chat-item-body' }, [heading, meta]);
  return h('li', { className: current ? 'chat-item current' : 'chat-item', dataset: { chatId: chat.id } }, [selector(chat, state, handlers), body]);
}

export function renderDispatchTools(refs, state) {
  const chatId = briefingChatId(state);
  const brief = chatId !== null && state.dispatchBrief?.chatId === chatId ? state.dispatchBrief : null;
  const busy = state.pending !== null;
  if (refs.dispatchBrief.dataset.chatId !== (chatId ?? '')) {
    refs.dispatchBrief.open = false;
    refs.dispatchBrief.dataset.chatId = chatId ?? '';
  }
  refs.dispatchBrief.hidden = chatId === null;
  const text = brief?.text ?? '';
  if (refs.dispatchBriefText.value !== text) refs.dispatchBriefText.value = text;
  refs.dispatchBriefClear.checked = brief?.clear === true;
  refs.dispatchBriefText.disabled = busy || refs.dispatchBriefClear.checked;
  refs.dispatchBriefClear.disabled = busy;
  refs.openOpener.disabled = busy;
  refs.openPhoneDispatch.disabled = busy;
  refs.generateOpener.disabled = busy;
}

function fillList(list, chats, state, handlers, today, emptyText) {
  clear(list);
  if (chats.length === 0) list.append(h('li', { className: 'empty', text: emptyText }));
  for (const chat of chats) list.append(chatItem(chat, state, handlers, today));
}

export function renderInbox(refs, state, handlers) {
  const reviewing = state.inboxFilter === 'review';
  const lower = state.inboxFilter === 'lower_concern';
  const lowerCount = state.chats.filter(chat => chat.lowerConcern).length;
  const previousCount = state.chats.filter(chat => chat.previousLowerConcern).length;
  const previous = lower ? state.chats.filter(chat => chat.previousLowerConcern)
    .sort((a, b) => b.previousLowerConcern.assessedAt.localeCompare(a.previousLowerConcern.assessedAt)) : [];
  const { newInbound, open } = groupInbox(state.chats, state.inboxFilter);
  const reviewCount = state.chats.filter(needsOfficerReview).length;
  const today = new Date().toISOString().slice(0, 10);
  withFocus(refs.inbox, () => {
    fillList(refs.newInboundList, newInbound, state, handlers, today, state.inboxLoaded ? 'No chats waiting.' : 'Loading…');
    fillList(refs.openList, open, state, handlers, today, state.inboxLoaded ? 'No open chats.' : 'Loading…');
    clear(refs.previousTestList);
    for (const chat of previous) {
      const { agreement } = chat.previousLowerConcern.sources;
      const link = h('a', { className: 'chat-link', href: chatHref(chat.id, agreement.messageId, agreement.messageEventId),
        dataset: { focusKey: `previous:${chat.id}` } }, [bdi(chat.displayLabel)]);
      refs.previousTestList.append(h('li', { className: 'chat-item' }, [h('div', { className: 'chat-item-body' }, [
        link, h('span', { className: 'hint', text: `Meeting arrangement · ${formatTime(chat.previousLowerConcern.assessedAt)}` }),
      ])]));
    }
  });
  refs.previousTestQueue.hidden = previous.length === 0;
  refs.newInboundList.closest('.queue').hidden = (lower || reviewing) && newInbound.length === 0;
  refs.openList.closest('.queue').hidden = (lower || reviewing) && open.length === 0;
  refs.inboxFilterAll.setAttribute('aria-pressed', String(!reviewing && !lower));
  refs.inboxFilterReview.setAttribute('aria-pressed', String(reviewing));
  refs.inboxFilterLowerConcern.setAttribute('aria-pressed', String(lower));
  refs.inboxFilterAll.textContent = state.inboxLoaded ? `All chats (${state.chatsTotal})` : 'All chats';
  refs.inboxFilterReview.textContent = state.inboxLoaded ? `Needs review (${reviewCount})` : 'Needs review';
  const periods = previousCount ? `${lowerCount} current · ${previousCount} previous` : lowerCount;
  refs.inboxFilterLowerConcern.textContent = state.inboxLoaded ? `Lower concern (${periods})` : 'Lower concern';
  refs.inboxFilterLowerConcern.disabled = state.pending !== null;
  refs.inboxFilterAll.disabled = state.pending !== null;
  refs.inboxFilterReview.disabled = state.pending !== null;
  const scope = [];
  if (state.chatsTotal > state.chats.length) scope.push(`Counts cover the ${state.chats.length} listed chats out of ${state.chatsTotal}.`);
  if (lower && state.inboxLoaded) scope.push(`${lowerCount} current · ${previous.length} previous`);
  if (reviewing && reviewCount === 0) scope.push(state.inboxLoaded ? 'No listed chats need officer review.' : 'Loading chats…');
  refs.queueScope.textContent = scope.join(' ');
  refs.queueScope.hidden = scope.length === 0;
  const selected = state.selection.size;
  refs.batchTools.hidden = selected === 0;
  refs.dispatchButton.disabled = selected === 0 || state.pending !== null;
  refs.selectionCount.textContent = selected ? `${selected} selected` : '';
}
