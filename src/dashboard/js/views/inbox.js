/**
 * The inbox: the New messages queue on top, then Suspects, then the open chats, each with a checkbox for Dispatch. A row says who holds
 * the chat (its mark and mode) and what is waiting for the officer, in the words the conversation header uses. A first-time
 * contact's row also previews its first message, masked, so the officer can choose whom to dispatch.
 */
import { bdi, clear, h, withFocus } from '../dom.js';
import { AI_MODE_LABELS, evidenceCountLabel, formatTime, reviewWarningLabel } from '../format.js';
import { controlState, reviewQueue } from '../state/attention.js';
import { briefingChatId, DISPATCH_LIMIT, groupInbox, isNewMessage, isSuspect, needsOfficerReview } from '../state/inbox.js';
import { chatHref } from '../state/route.js';

/** Short channel marks for the dense list; the full channel name stays in the row for assistive tools. */
const CHANNEL_CODES = { telegram: 'TG' };

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

function channelMark(chat) {
  const code = CHANNEL_CODES[chat.source] ?? chat.channelLabel.slice(0, 2).toUpperCase();
  return h('span', { className: 'channel', title: chat.channelLabel, dataset: { code } }, [h('span', { className: 'visually-hidden', text: chat.channelLabel })]);
}

function contactMark(label, rowNumber) {
  const words = label.match(/\p{L}[\p{L}\p{M}]*/gu) ?? [];
  const initials = [words[0], words.length > 1 ? words.at(-1) : '']
    .map(word => word?.match(/^\p{L}\p{M}*/u)?.[0] ?? '').join('').toLocaleUpperCase();
  return h('span', { className: 'chat-row-mark', 'aria-hidden': 'true' }, [
    h('span', { className: 'contact-mark', dir: 'auto', text: initials }),
    h('span', { className: 'chat-row-number', dir: 'ltr', text: String(rowNumber).padStart(2, '0') }),
  ]);
}

/** Who holds the chat. Replies held for review is its own state: the AI is active but waiting for the officer. */
function controlChips(chat, control, me) {
  if (control === 'ai_held') return [h('span', { className: 'ai-mode mode-held', text: 'Replies held' })];
  const mode = h('span', { className: `ai-mode mode-${chat.aiMode}`, text: AI_MODE_LABELS[chat.aiMode] ?? chat.aiMode });
  if (chat.aiMode !== 'officer_control' || chat.controller === null) return [mode];
  const mine = Boolean(me) && chat.controller.id === me.id;
  return [mode, h('span', { className: 'chat-controller' }, [mine ? h('span', { text: 'you' }) : bdi(chat.controller.displayName)])];
}

/** The first strong character is from a right-to-left script (Hebrew, Arabic, Syriac, Thaana and their presentation forms). */
const RTL_FIRST = /^[^\p{L}]*[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;

/** What a first-time contact wrote first: the masked preview, or what it carried instead. */
function firstContactLine(first) {
  if (!first) return null;
  let content;
  if (first.deleted) content = h('span', { className: 'first-contact-note', text: 'Deleted by the sender' });
  else if (first.preview) content = h('q', { dir: 'auto', text: first.preview });
  else if (first.notCaptured.length) content = h('span', { className: 'first-contact-note', text: `Not captured: ${first.notCaptured.join(', ')}` });
  else content = h('span', { className: 'first-contact-note', text: 'No text' });
  // The paragraph follows the message's own direction, so an Arabic preview aligns and clips from the right.
  const rtl = first.preview !== null && RTL_FIRST.test(first.preview);
  return h('p', { className: 'first-contact', dir: rtl ? 'rtl' : 'ltr' }, [h('span', { className: 'visually-hidden', text: 'First message: ' }), content]);
}

/** How many messages the first-time contact has sent, when more than one is waiting. */
function waitingCount(chat) {
  const count = isNewMessage(chat) ? chat.firstContact?.incomingCount ?? 0 : 0;
  return count > 1 ? h('span', { className: 'first-contact-more', text: `${count} messages` }) : null;
}

/** Who flagged the suspect and the number now on the watchlist. */
function suspectLine(suspect) {
  return h('p', { className: 'suspect-line' }, [
    h('span', { text: suspect.flaggedBy ? 'Flagged by ' : 'Flagged' }),
    suspect.flaggedBy ? bdi(suspect.flaggedBy.displayName) : null,
    h('span', { text: ' · ' }),
    h('bdi', { dir: 'ltr', text: suspect.numberDisplay }),
    h('span', { text: ' on the watchlist' }),
  ]);
}

function chatItem(chat, state, handlers, today, rowNumber) {
  const current = chat.id === state.selectedChatId;
  const control = controlState(chat, state.me);
  const { items, blocking } = reviewQueue(chat.telegramReplyHold);
  const warnings = items.map(item => reviewWarningLabel(item.reason)).filter(Boolean);
  const link = h('a', { href: chatHref(chat.id), className: 'chat-link', 'aria-current': current ? 'page' : null, dataset: { focusKey: `open:${chat.id}` } }, [
    bdi(chat.displayLabel),
  ]);
  const heading = h('div', { className: 'chat-item-heading' }, [link, activityTime(chat.lastActivityAt, today), selector(chat, state, handlers)]);
  const meta = h('p', { className: 'chat-meta' }, [
    channelMark(chat),
    isSuspect(chat) ? h('span', { className: 'suspect-chip', text: 'Suspect' }) : null,
    ...controlChips(chat, control, state.me),
    waitingCount(chat),
    chat.telegramReplyHold.contactOptedOut ? h('span', { className: 'flag', text: 'Contact opted out' }) : null,
    warnings.length ? h('span', { className: 'evidence-warning', text: warnings.length === 1 ? warnings[0] : `${warnings.length} warnings` }) : null,
    items.length > warnings.length
      ? h('span', { className: blocking ? 'review-chip review-chip-blocking' : 'review-chip', text: evidenceCountLabel(items.length) }) : null,
    chat.watchlistMatches.length && !isSuspect(chat) ? h('span', { className: 'badge badge-match', text: 'Watchlist match' }) : null,
    chat.lowerConcern ? h('span', { className: 'lower-concern-badge', text: 'Lower concern' }) : null,
    chat.review.state === 'unavailable' ? h('span', { className: 'review-note-unavailable', text: 'Review unavailable' }) : null,
  ]);
  const body = h('div', { className: 'chat-item-body' }, [heading, meta,
    isNewMessage(chat) ? firstContactLine(chat.firstContact) : null, isSuspect(chat) ? suspectLine(chat.suspect) : null]);
  return h('li', {
    className: (current ? 'chat-item current' : 'chat-item') + (isSuspect(chat) ? ' chat-item-suspect' : ''),
    dataset: { chatId: chat.id, control, review: blocking ? 'blocking' : items.length > 0 ? 'captured' : 'none' },
  }, [contactMark(chat.displayLabel, rowNumber), body]);
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

function fillList(list, chats, state, handlers, today, firstNumber, emptyText) {
  clear(list);
  list.start = firstNumber;
  if (chats.length === 0) list.append(h('li', { className: 'empty', text: emptyText }));
  for (const [index, chat] of chats.entries()) list.append(chatItem(chat, state, handlers, today, firstNumber + index));
  const count = list.closest('.queue')?.querySelector('.queue-count');
  if (count) count.textContent = state.inboxLoaded ? String(chats.length) : '';
}

/**
 * A filter is its label and, once the inbox has loaded, a count. `urgent` marks a count that is waiting on the officer;
 * `earlier` adds the previous tests kept under Lower concern.
 */
function fillFilter(button, label, count, { urgent = false, earlier = 0 } = {}) {
  button.replaceChildren(h('span', { text: label }));
  if (count === null) return;
  // The spaces keep the label and the counts apart in the button's accessible name.
  button.append(document.createTextNode(' '), h('span', { className: urgent ? 'count count-urgent' : 'count', text: String(count) }));
  if (earlier > 0) {
    button.append(document.createTextNode(' '), h('span', { className: 'count count-earlier' }, [
      h('span', { 'aria-hidden': 'true', text: `+${earlier}` }), h('span', { className: 'visually-hidden', text: `and ${earlier} previous` }),
    ]));
  }
}

export function renderInbox(refs, state, handlers) {
  const reviewing = state.inboxFilter === 'review';
  const lower = state.inboxFilter === 'lower_concern';
  const fresh = state.inboxFilter === 'new_messages';
  const suspecting = state.inboxFilter === 'suspects';
  const filtered = state.inboxFilter !== 'all';
  const newCount = state.chats.filter(isNewMessage).length;
  const suspectCount = state.chats.filter(isSuspect).length;
  const lowerCount = state.chats.filter(chat => chat.lowerConcern).length;
  const previousCount = state.chats.filter(chat => chat.previousLowerConcern).length;
  const previous = lower ? state.chats.filter(chat => chat.previousLowerConcern)
    .sort((a, b) => b.previousLowerConcern.assessedAt.localeCompare(a.previousLowerConcern.assessedAt)) : [];
  const { newInbound, suspects, open } = groupInbox(state.chats, state.inboxFilter);
  const reviewCount = state.chats.filter(needsOfficerReview).length;
  const today = new Date().toISOString().slice(0, 10);
  withFocus(refs.inbox, () => {
    fillList(refs.newInboundList, newInbound, state, handlers, today, 1, state.inboxLoaded ? 'No new messages.' : 'Loading…');
    fillList(refs.suspectList, suspects, state, handlers, today, newInbound.length + 1, 'No suspects.');
    fillList(refs.openList, open, state, handlers, today, newInbound.length + suspects.length + 1, state.inboxLoaded ? 'No open chats.' : 'Loading…');
    clear(refs.previousTestList);
    refs.previousTestList.start = newInbound.length + suspects.length + open.length + 1;
    for (const [index, chat] of previous.entries()) {
      const { agreement } = chat.previousLowerConcern.sources;
      const link = h('a', { className: 'chat-link', href: chatHref(chat.id, agreement.messageId, agreement.messageEventId),
        dataset: { focusKey: `previous:${chat.id}` } }, [bdi(chat.displayLabel)]);
      refs.previousTestList.append(h('li', { className: 'chat-item chat-item-archived' }, [
        contactMark(chat.displayLabel, refs.previousTestList.start + index),
        h('div', { className: 'chat-item-body' }, [
          link, h('span', { className: 'hint', text: `Meeting arrangement · ${formatTime(chat.previousLowerConcern.assessedAt)}` }),
        ]),
      ]));
    }
    const loaded = state.inboxLoaded;
    fillFilter(refs.inboxFilterAll, 'All chats', loaded ? state.chatsTotal : null);
    fillFilter(refs.inboxFilterNew, 'New messages', loaded ? newCount : null, { urgent: newCount > 0 });
    fillFilter(refs.inboxFilterSuspects, 'Suspects', loaded ? suspectCount : null);
    fillFilter(refs.inboxFilterReview, 'Needs review', loaded ? reviewCount : null, { urgent: reviewCount > 0 });
    fillFilter(refs.inboxFilterLowerConcern, 'Lower concern', loaded ? lowerCount : null, { earlier: previousCount });
    refs.inboxFilterLowerConcern.title = previousCount ? `${lowerCount} current · ${previousCount} in previous tests` : '';
  });
  refs.previousTestQueue.hidden = previous.length === 0;
  refs.newInboundList.closest('.queue').hidden = filtered && newInbound.length === 0;
  refs.suspectQueue.hidden = suspects.length === 0;
  refs.openList.closest('.queue').hidden = filtered && open.length === 0;
  refs.inboxFilterAll.setAttribute('aria-pressed', String(!filtered));
  refs.inboxFilterNew.setAttribute('aria-pressed', String(fresh));
  refs.inboxFilterSuspects.setAttribute('aria-pressed', String(suspecting));
  refs.inboxFilterReview.setAttribute('aria-pressed', String(reviewing));
  refs.inboxFilterLowerConcern.setAttribute('aria-pressed', String(lower));
  refs.inboxFilterLowerConcern.disabled = state.pending !== null;
  refs.inboxFilterAll.disabled = state.pending !== null;
  refs.inboxFilterNew.disabled = state.pending !== null;
  refs.inboxFilterSuspects.disabled = state.pending !== null;
  refs.inboxFilterReview.disabled = state.pending !== null;
  const scope = [];
  if (state.chatsTotal > state.chats.length) scope.push(`Counts cover the ${state.chats.length} listed chats out of ${state.chatsTotal}.`);
  if (lower && state.inboxLoaded) scope.push(`${lowerCount} current · ${previous.length} previous`);
  if (reviewing && reviewCount === 0) scope.push(state.inboxLoaded ? 'No listed chats need officer review.' : 'Loading chats…');
  if (fresh && newCount === 0) scope.push(state.inboxLoaded ? 'No first-time messages are waiting.' : 'Loading chats…');
  if (suspecting && suspectCount === 0) scope.push(state.inboxLoaded ? 'No chats are flagged as scammers.' : 'Loading chats…');
  if (suspecting && suspectCount > 0) scope.push('Contacts an officer flagged as scammers. Clearing the number on the phone watchlist moves a chat back.');
  if (fresh && newCount > 0) scope.push('First-time contacts nobody has answered yet. Select whom to dispatch; one selected chat can take a briefing.');
  refs.queueScope.textContent = scope.join(' ');
  refs.queueScope.hidden = scope.length === 0;
  const selected = state.selection.size;
  const selectable = newInbound.length + suspects.length + open.length;
  const tooMany = selected > DISPATCH_LIMIT;
  refs.selectAllChats.checked = selectable > 0 && selected === selectable;
  refs.selectAllChats.indeterminate = selected > 0 && selected < selectable;
  refs.selectAllChats.disabled = !state.inboxLoaded || selectable === 0 || state.pending !== null;
  refs.dispatchButton.disabled = selected === 0 || tooMany || state.pending !== null;
  refs.selectionCount.textContent = tooMany
    ? `${selected} selected. Deselect ${selected - DISPATCH_LIMIT} or more to dispatch up to ${DISPATCH_LIMIT} at once.`
    : selected ? `${selected} selected` : '';
}
