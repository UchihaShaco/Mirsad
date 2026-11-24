/**
 * The selected chat's header answers three questions, in this order: who controls the chat (the control strip, with the
 * actions that change it), what is waiting for the officer (evidence for review, blocking or not) and which message
 * explains it (every reason links to its exact source). The service decides every rule; this only reads what it sent.
 */
import { append, bdi, clear, h, withFocus } from '../dom.js';
import {
  AI_MODE_LABELS, conversationReviewSummary, dispatchReason, evidenceCountLabel, formatClock, formatCompactTime, formatTime, reviewWarningLabel, telegramRequestReceipt, TELEGRAM_EVIDENCE_LABELS,
} from '../format.js';
import { controlState, isLiveChat, itemHoldsReplies, reviewQueue } from '../state/attention.js';
import { chatHref } from '../state/route.js';

const REVIEW_SUMMARY = {
  active: (review) => `Review in progress (${review.pending} pending).`,
  unavailable: (review) => `Review unavailable for ${review.unavailable} message(s); capture and controls keep working.`,
};
const PERMISSION_NEEDED = 'Choose Dispatch once the participant has agreed.';
const OPTED_OUT = 'Contact opted out of automated replies. They can start a new exchange by asking for a reply.';
const FINDINGS_SHOWN = 3;

const CONTROL_LABELS = { pause: 'Pause AI', take_over: 'Take over', resume: 'Resume AI' };
/** What each control does, as its tooltip. */
const CONTROL_HINTS = {
  pause: 'Stops the AI on this chat until an officer resumes it. Messages are still captured.',
  take_over: 'Puts you in control of this chat and opens the composer. The AI stays silent.',
  resume: 'Hands this chat back to the AI.',
};
/**
 * The controls offered in each state, most relevant first, and the one recommended next action. Dispatch is the page's
 * own button: the workspace hides it when a chat cannot be dispatched.
 */
const CONTROL_PLAN = {
  not_started: { actions: ['take_over'], primary: 'dispatch' },
  ai_active: { actions: ['pause', 'take_over'], primary: null },
  ai_waiting: { actions: ['pause', 'take_over'], primary: 'dispatch' },
  ai_held: { actions: ['take_over', 'pause'], primary: null },
  ai_opted_out: { actions: ['take_over', 'pause'], primary: null },
  paused: { actions: ['resume', 'take_over'], primary: 'resume' },
  officer_self: { actions: ['resume'], primary: null },
  // Resume AI stays visible here, disabled: it tells the officer why the chat cannot simply be handed back.
  officer_other: { actions: ['take_over', 'resume'], primary: null },
};

/**
 * Which controls can apply, mirroring design section 8 so impossible actions are not offered. The service decides:
 * a stale or refused action still comes back as an error, which the dashboard shows.
 */
function availableControls(chat, me) {
  const isController = chat.controller !== null && chat.controller.id === me.id;
  return {
    pause: chat.aiMode === 'ai_active',
    take_over: !(chat.aiMode === 'officer_control' && isController),
    resume: chat.aiMode === 'paused' || (chat.aiMode === 'officer_control' && isController),
  };
}

/** Ali replies in live Telegram chats; anything else (fixture replay, imports) is AI review. */
function voiceOf(timeline) {
  return !isLiveChat(timeline) && timeline.telegramAiPermission === undefined ? 'review' : 'ali';
}

function initials(name) {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const picked = words.length > 1 ? [words[0], words.at(-1)] : words;
  return picked.map((word) => [...word][0] ?? '').join('').toLocaleUpperCase();
}

/** The last officer action of one type in the case log: who paused or took over, and when. */
function lastAction(timeline, type) {
  let last = null;
  for (const action of timeline.caseActions) {
    if (action.type === type && (last === null || action.position > last.position)) last = action;
  }
  return last;
}

const text = (value) => h('span', { text: value });

/** The headline and the sentence under it: who holds the chat right now, and what that means for replies. */
function controlCopy(key, { chat, voice, repliesOff, pausedBy }) {
  const ali = voice === 'ali';
  const silent = ali ? 'Ali is silent on this chat.' : 'The AI is off for this chat.';
  switch (key) {
    case 'ai_active':
      if (voice === 'review') return { headline: [text('AI review is running')], note: 'New messages are reviewed as they arrive.' };
      return repliesOff
        ? { headline: [text('Ali is on standby')], note: 'Account-wide replies are off in Settings, so nothing is sent from this chat.' }
        : { headline: [text('Ali is handling replies')], note: 'Ali answers eligible incoming messages. Pause AI or Take over stops automated replies.' };
    case 'ai_waiting':
      return { headline: [text('Ali is waiting for permission')], note: PERMISSION_NEEDED };
    case 'ai_held':
      return { headline: [text('Bank details need your review')], note: 'Mark the bank details as reviewed so Ali can reply again.' };
    case 'ai_opted_out':
      return { headline: [text('Ali is silent: the contact opted out')], note: OPTED_OUT };
    case 'paused':
      return {
        headline: pausedBy ? [text('Paused by '), bdi(pausedBy)] : [text('Paused')],
        note: ali ? 'Messages are still captured and no automated reply is sent. Resume AI hands the chat back to Ali.'
          : 'Messages are still captured. Resume AI hands the chat back to the AI.',
      };
    case 'officer_self':
      return { headline: [text('You are in control')], note: `${silent} Resume AI hands it back.` };
    case 'officer_other':
      return {
        headline: chat.controller ? [bdi(chat.controller.displayName), text(' is in control')] : [text('Another officer is in control')],
        note: `${silent} Only the controlling officer can resume the AI. Take over moves control to you.`,
      };
    default:
      if (voice === 'review') return { headline: [text('AI review has not started')], note: 'Messages are captured. Dispatch starts AI review. Take over keeps the chat with you.' };
      return { headline: [text('Nobody is replying yet')], note: 'Incoming messages are captured. Dispatch hands this chat to Ali. Take over keeps it with you.' };
  }
}

/** The badge at the head of the strip: AI for the automated states, the controlling officer's initials otherwise. */
function markText(key, chat, me) {
  if (key === 'officer_self') return initials(me.displayName);
  if (key === 'officer_other') return chat.controller ? initials(chat.controller.displayName) : '';
  return key.startsWith('ai_') ? 'AI' : '';
}

function controlButton(action, { available, busy, primary, handlers }) {
  const button = h('button', {
    type: 'button', text: CONTROL_LABELS[action], title: CONTROL_HINTS[action], className: primary ? 'primary' : null,
    disabled: busy || !available[action], dataset: { focusKey: `control:${action}` },
  });
  button.addEventListener('click', () => handlers.onControl(action));
  return button;
}

/** Facts that stay true whatever the mode, each on its own line under the strip's sentence. */
function controlExtras(key, timeline) {
  const { chat } = timeline;
  const extras = [];
  if (key !== 'ai_waiting' && chat.aiMode === 'ai_active' && timeline.telegramAiPermission === 'needed') {
    extras.push(h('p', { className: 'control-extra', text: PERMISSION_NEEDED }));
  }
  if (key !== 'ai_opted_out' && chat.telegramReplyHold.contactOptedOut) extras.push(h('p', { className: 'control-extra flag', text: OPTED_OUT }));
  const summary = REVIEW_SUMMARY[chat.review.state];
  if (summary) {
    extras.push(h('p', { className: `control-extra review-summary review-summary-${chat.review.state}` }, [
      text(summary(chat.review)),
      chat.review.state === 'unavailable' ? h('span', { className: 'hint', text: ' Dispatch or Resume AI queues these reviews again.' }) : null,
    ]));
  }
  return extras;
}

function controlStrip(refs, state, handlers, key) {
  const { timeline } = state;
  const { chat } = timeline;
  const plan = CONTROL_PLAN[key];
  const since = key === 'paused' ? lastAction(timeline, 'control_pause') : key.startsWith('officer_') ? lastAction(timeline, 'control_take_over') : null;
  const copy = controlCopy(key, {
    chat, voice: voiceOf(timeline), repliesOff: state.dmReplies?.mode === 'off', pausedBy: since?.actor?.displayName ?? null,
  });
  const replies = timeline.telegramReplies;
  if (replies?.automatic === 'replies_offline' || replies?.automatic === 'replies_off') {
    copy.headline = [text('Automatic replies are off')];
    copy.note = dispatchReason(replies.automatic);
  }
  const options = { available: availableControls(chat, state.me), busy: state.pending !== null, handlers };
  const buttons = plan.actions.map((action) => controlButton(action, { ...options, primary: plan.primary === action }));
  // Dispatch belongs with the other controls. It is the page's own button, so its dialog and handlers stay bound.
  const dispatch = refs.openChatDispatch;
  dispatch.classList.toggle('primary', plan.primary === 'dispatch');
  dispatch.classList.toggle('quiet', plan.primary !== 'dispatch');
  const actions = plan.primary === 'dispatch' ? [dispatch, ...buttons] : [...buttons, dispatch];
  if (replies && !replies.blocked && ['ai_active', 'not_started'].includes(chat.aiMode)) {
    const brief = h('button', { type: 'button', className: 'quiet', text: 'Dispatch with briefing…',
      'aria-haspopup': 'dialog', disabled: options.busy || (replies.request?.status === 'queued' && replies.request.kind !== 'consent_notice'), dataset: { focusKey: 'control:briefing' } });
    brief.addEventListener('click', () => handlers.onDispatchWithBrief());
    actions.push(brief);
  }
  const headline = [...copy.headline];
  if (since) {
    headline.push(h('time', { className: 'control-since', datetime: since.occurredAt, title: formatTime(since.occurredAt), text: `since ${formatCompactTime(since.occurredAt)}` }));
  }
  return h('section', { className: 'control-strip', dataset: { state: key }, 'aria-label': 'Who controls this chat' }, [
    h('span', { className: 'control-mark', 'aria-hidden': 'true', text: markText(key, chat, state.me) }),
    h('div', { className: 'control-status' }, [
      h('p', { className: 'control-headline' }, headline),
      h('p', { className: 'control-note' }, [
        h('span', { className: 'chat-mode' }, [h('span', { className: `ai-mode mode-${chat.aiMode}`, text: AI_MODE_LABELS[chat.aiMode] ?? chat.aiMode })]),
        text(copy.note),
      ]),
      ...controlExtras(key, timeline),
      replies?.request ? h('p', { className: 'control-extra dispatch-delivery', role: 'status', dataset: { status: replies.request.status } }, [
        h('strong', { text: 'Last dispatch' }), text(telegramRequestReceipt(replies.request, timeline.caseActions)),
        replies.request.replyMessageId ? h('a', { href: chatHref(chat.id, replies.request.replyMessageId), text: replies.request.kind === 'consent_notice' ? 'View invitation' : 'View reply',
          dataset: { focusKey: 'dispatch-reply' } }) : null,
      ]) : null,
    ]),
    h('div', { className: 'controls', role: 'group', 'aria-label': 'AI control for this chat' }, actions),
  ]);
}

function placeholder(state) {
  if (state.selectedChatId === null) return h('p', { className: 'placeholder conversation-empty' }, [
    h('span', { className: 'empty-chat-mark', 'aria-hidden': 'true' }),
    h('span', { text: 'Select a chat in the inbox to see its timeline.' }),
  ]);
  if (state.timelineError !== null) return h('p', { className: 'error', text: state.timelineError });
  return h('p', { className: 'placeholder', text: 'Loading the chat…' });
}

function identity(state) {
  const { chat } = state.timeline;
  return h('div', { className: 'chat-identity' }, [
    h('h2', { className: 'chat-title' }, [bdi(chat.displayLabel)]),
    h('p', { className: 'chat-meta' }, [
      h('span', { className: 'channel-name', text: chat.channelLabel }),
      text(chat.originLabel),
      !state.previous && state.timeline.telegramAiPermission === 'approved' ? h('span', { className: 'permission-approved', text: 'Approved for AI replies' }) : null,
      h('span', { className: 'revision', title: 'Control revision of this chat', text: `Revision ${chat.revision}` }),
    ]),
  ]);
}

/** Where the item sits in the conversation, from the open timeline: the edit that carried it, or the original message. */
function sourceTime(timeline, item) {
  const event = timeline.messageEvents.find((candidate) => candidate.id === item.messageEventId);
  const received = event?.receivedAt ?? timeline.messages.find((message) => message.id === item.messageId)?.receivedAt;
  if (!received) return null;
  return h('time', { className: 'review-when', datetime: received, title: formatTime(received), text: `${event ? 'Edit' : 'Message'} received ${formatCompactTime(received)}` });
}

function reviewTitle(reason) {
  const label = TELEGRAM_EVIDENCE_LABELS[reason] ?? 'item';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Link each open item to its exact source and let the officer acknowledge it independently. */
function reviewRow(item, timeline, busy, handlers) {
  const { chat } = timeline;
  const warning = reviewWarningLabel(item.reason);
  const conversation = item.reason === 'conversation_review';
  const evidenceLabel = TELEGRAM_EVIDENCE_LABELS[item.reason] ?? 'item';
  let sourceLabel = `Review shared ${evidenceLabel}`;
  if (conversation) sourceLabel = 'View flagged message';
  else if (warning) sourceLabel = item.reason === 'link' ? 'View link source' : 'View payment link source';
  const source = h('a', {
    className: 'review-source',
    href: chatHref(chat.id, item.messageId, item.messageEventId),
    text: sourceLabel,
    dataset: { focusKey: `review-source:${item.actionId}` },
  });
  let note = 'Shared by the contact.';
  if (item.reason === 'model_payment_link') note = 'Ali flagged an unverified payment request.';
  if (conversation) note = conversationReviewSummary(timeline.caseActions.find((action) => action.id === item.actionId)?.detail);
  const button = h('button', { type: 'button', text: 'Mark reviewed', disabled: busy, dataset: { focusKey: `review:${item.actionId}` } });
  button.addEventListener('click', () => handlers.onMarkReviewed(chat.id, item.actionId, chat.revision));
  return h('li', { className: warning ? 'review-item review-item-warning' : 'review-item', dataset: { reason: item.reason } }, [
    h('div', { className: 'review-reason' }, [
      h('strong', { className: 'review-title', text: warning ?? reviewTitle(item.reason) }),
      itemHoldsReplies(item, chat.telegramReplyHold) ? h('span', { className: 'review-chip review-chip-blocking', text: 'Holds replies' }) : null,
      // The reason a model or a rule gave stays readable at every width; "Shared by the contact." gives way first.
      h('p', { className: 'review-note' }, [h('span', { className: item.reason === 'model_payment_link' || conversation ? null : 'review-origin', text: note }), sourceTime(timeline, item)]),
    ]),
    source, button,
  ]);
}

/** Only the bank details in a mixed warning queue require a hold. */
function reviewNotice(timeline, busy, handlers, key) {
  const { chat } = timeline;
  const hold = chat.telegramReplyHold;
  const { items, blocking } = reviewQueue(hold);
  if (items.length === 0) return null;
  let effect = null;
  if (blocking) effect = h('span', { className: 'review-effect flag', text: 'Bank details are holding replies.' });
  else if (timeline.telegramReplies ? timeline.telegramReplies.automatic === 'active' : key === 'ai_active') {
    effect = h('span', { className: 'review-effect', text: 'Automated replies can continue.' });
  }
  return h('section', { className: 'review-notice', dataset: { blocking: String(blocking) }, 'aria-label': 'Evidence for officer review' }, [
    h('div', { className: 'review-head' }, [
      h('span', { className: 'review-state', text: blocking ? 'Review required' : 'Captured' }),
      h('strong', { className: 'review-count', text: evidenceCountLabel(items.length) }),
      effect,
    ]),
    h('ul', { className: 'review-items' }, items.map((item) => reviewRow(item, timeline, busy, handlers))),
  ]);
}

/** Standing signals of the conversation, each with a way to its source: watchlist matches, the assessment, findings. */
function signals(state, handlers) {
  const { chat, findings } = state.timeline;
  const suspect = state.previous ? null : chat.suspect;
  const rows = [];
  if (suspect) {
    rows.push(h('li', { className: 'signal signal-suspect' }, [
      h('strong', { className: 'suspect-chip', text: 'Suspect' }),
      // One sentence in one span, so the signal's flex gap does not split it around the names.
      h('span', {}, [
        document.createTextNode(suspect.flaggedBy ? 'Flagged as a scammer by ' : 'Flagged as a scammer. '),
        suspect.flaggedBy ? bdi(suspect.flaggedBy.displayName) : null,
        document.createTextNode(suspect.flaggedBy ? '. ' : ''),
        h('bdi', { dir: 'ltr', text: suspect.numberDisplay }),
        document.createTextNode(' is on the phone watchlist.'),
      ]),
      h('a', { href: '#/watchlist', text: 'Open watchlist', dataset: { focusKey: 'signal-suspect' } }),
    ]));
  }
  rows.push(...chat.watchlistMatches.filter(match => match.entryId !== suspect?.watchlistEntryId).map((match) => {
    const open = h('button', { type: 'button', className: 'quiet', text: 'Show evidence', dataset: { focusKey: `signal-match:${match.entryId}` } });
    open.addEventListener('click', () => handlers.onShowEvidence());
    return h('li', { className: 'signal signal-match' }, [h('strong', { className: 'badge badge-match', text: 'Watchlist match' }), bdi(match.numberDisplay), open]);
  }));
  if (!state.previous && chat.lowerConcern) {
    const { agreement } = chat.lowerConcern.sources;
    rows.push(h('li', { className: 'signal signal-lower lower-concern-note' }, [
      h('strong', { className: 'lower-concern-badge', text: 'Lower concern' }),
      text(' Meeting arranged. '),
      h('a', { href: chatHref(chat.id, agreement.messageId, agreement.messageEventId), text: 'See agreement', dataset: { focusKey: 'signal-lower' } }),
    ]));
  }
  const newest = [...findings].sort((a, b) => b.position - a.position);
  for (const finding of newest.slice(0, FINDINGS_SHOWN)) {
    rows.push(h('li', { className: `signal signal-finding signal-${finding.kind}` }, [
      h('a', { href: chatHref(finding.chatId, finding.messageId), text: finding.label, dataset: { focusKey: `signal-finding:${finding.id}` } }),
      h('time', { datetime: finding.createdAt, title: formatTime(finding.createdAt), text: formatClock(finding.createdAt) }),
    ]));
  }
  if (newest.length > FINDINGS_SHOWN) rows.push(h('li', { className: 'signal signal-more', text: `${newest.length - FINDINGS_SHOWN} more in the conversation` }));
  return rows.length === 0 ? null : h('ul', { className: 'signals', 'aria-label': 'Signals in this conversation' }, rows);
}

export function renderChatHeader(refs, state, handlers) {
  const container = refs.chatHeader;
  withFocus(container, () => {
    clear(container);
    delete container.dataset.control;
    if (state.timeline === null) {
      container.append(placeholder(state));
      return;
    }
    const { timeline } = state;
    const key = controlState(timeline.chat, state.me, timeline.telegramAiPermission);
    container.dataset.control = key;
    append(container, [
      identity(state),
      state.previous ? null : controlStrip(refs, state, handlers, key),
      reviewNotice(state.wholeTimeline ?? timeline, state.pending !== null, handlers, state.previous ? null : key),
      signals(state, handlers),
    ]);
  });
}
