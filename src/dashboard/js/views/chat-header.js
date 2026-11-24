/** The selected chat's header: label, channel, origin label, AI mode and the Pause AI / Take over / Resume AI controls. */
import { append, bdi, clear, h, withFocus } from '../dom.js';
import { AI_MODE_LABELS, conversationReviewSummary, evidenceCountLabel, evidenceItemsFor, TELEGRAM_EVIDENCE_LABELS } from '../format.js';
import { chatHref } from '../state/route.js';

const REVIEW_SUMMARY = {
  active: (review) => `Review in progress (${review.pending} pending).`,
  unavailable: (review) => `Review unavailable for ${review.unavailable} message(s); capture and controls keep working.`,
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

function controls(chat, state, handlers) {
  const available = availableControls(chat, state.me);
  const control = (action, label) => {
    const button = h('button', { type: 'button', text: label, disabled: state.pending !== null || !available[action], dataset: { focusKey: `control:${action}` } });
    button.addEventListener('click', () => handlers.onControl(action));
    return button;
  };
  return h('div', { className: 'controls', role: 'group', 'aria-label': 'AI control for this chat' }, [
    control('pause', 'Pause AI'),
    control('take_over', 'Take over'),
    control('resume', 'Resume AI'),
  ]);
}

function modeLine(chat) {
  const parts = [h('span', { className: `ai-mode mode-${chat.aiMode}`, text: AI_MODE_LABELS[chat.aiMode] ?? chat.aiMode })];
  if (chat.controller !== null) parts.push(h('span', { text: ' by ' }), bdi(chat.controller.displayName));
  return h('span', { className: 'chat-mode' }, parts);
}

function placeholder(state) {
  if (state.selectedChatId === null) return h('p', { className: 'placeholder', text: 'Select a chat in the inbox to see its timeline.' });
  if (state.timelineError !== null) return h('p', { className: 'error', text: state.timelineError });
  return h('p', { className: 'placeholder', text: 'Loading the chat…' });
}

function reviewNotice(timeline, busy, handlers) {
  const { chat } = timeline;
  const hold = chat.telegramReplyHold;
  const items = evidenceItemsFor(hold);
  if (items.length === 0) return null;
  const held = hold.officerReview !== null;
  const rows = items.map((item) => {
    const paymentReview = item.reason === 'model_payment_link';
    const source = h('a', {
      href: chatHref(chat.id, item.messageId, item.messageEventId),
      text: item.reason === 'conversation_review' ? 'View the message that triggered review'
        : paymentReview ? 'View payment link source' : `Review shared ${TELEGRAM_EVIDENCE_LABELS[item.reason] ?? 'item'}`,
      dataset: { focusKey: `review-source:${item.actionId}` },
    });
    let description = source;
    if (item.reason === 'conversation_review') {
      const report = timeline.caseActions.find(action => action.id === item.actionId);
      description = h('div', {}, [h('div', { text: conversationReviewSummary(report?.detail) }), source]);
    }
    if (paymentReview) description = h('div', {}, [
      h('strong', { text: 'Payment link needs review' }),
      h('p', { text: 'Ali flagged an unverified payment request.' }),
      source,
    ]);
    const row = h('li', { className: paymentReview ? 'review-item review-item-payment' : 'review-item' }, [description]);
    if (held) {
      const button = h('button', { type: 'button', text: 'Mark reviewed', disabled: busy, dataset: { focusKey: `review:${item.actionId}` } });
      button.addEventListener('click', () => handlers.onMarkReviewed(chat.id, item.actionId, chat.revision));
      row.append(button);
    }
    return row;
  });
  return h('section', { className: 'review-notice', 'aria-label': 'Evidence for officer review' }, [
    h('strong', { text: evidenceCountLabel(items.length) }),
    held ? h('span', { className: 'flag', text: 'Automated replies held for evidence review.' })
      : chat.aiMode === 'ai_active' && !hold.contactOptedOut ? h('span', { text: 'Automated replies can continue.' }) : null,
    h('ul', { className: 'review-items' }, rows),
  ]);
}

export function renderChatHeader(container, state, handlers) {
  withFocus(container, () => {
    clear(container);
    if (state.timeline === null) {
      container.append(placeholder(state));
      return;
    }
    const { chat } = state.timeline;
    const summary = REVIEW_SUMMARY[chat.review.state];
    append(container, [
      h('h2', { className: 'chat-title' }, [bdi(chat.displayLabel)]),
      h('p', { className: 'chat-meta' }, [
        h('span', { className: 'badge', text: chat.channelLabel }),
        h('span', { text: chat.originLabel }),
        modeLine(chat),
        h('span', { text: `Revision ${chat.revision}` }),
      ]),
      summary ? h('p', { className: 'hint', text: summary(chat.review) }) : null,
      chat.telegramReplyHold.contactOptedOut ? h('p', { className: 'flag', text: 'Contact opted out of automated replies. They can start a new exchange by asking for a reply.' }) : null,
      reviewNotice(state.wholeTimeline ?? state.timeline, state.pending !== null, handlers),
      !state.previous && chat.lowerConcern ? h('p', { className: 'lower-concern-note' }, [
        h('strong', { className: 'lower-concern-badge', text: 'Lower concern' }),
        h('span', { text: ' Meeting arranged. ' }),
        h('a', { href: chatHref(chat.id, chat.lowerConcern.sources.agreement.messageId, chat.lowerConcern.sources.agreement.messageEventId),
          text: 'See agreement' }),
      ]) : null,
      state.previous ? null : controls(chat, state, handlers),
    ]);
  });
}
