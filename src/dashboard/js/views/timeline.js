/**
 * The selected chat's timeline: messages in both directions with source, capture method, receipt time, capture and
 * review status; edits, deletions and conflicting copies as their own entries; findings as one compact note each. Case
 * actions go to the case log beside it. Message text is plain text in a dir="auto" element.
 */
import { bdi, clear, h, timeEl, withFocus } from '../dom.js';
import { CAPTURE_METHOD_LABELS, DIRECTION_LABELS, formatTime, reviewStatusLabel } from '../format.js';
import { canCompose } from '../state/composer.js';
import { chatHref } from '../state/route.js';
import { senderPhoneOf, timelineEntries } from '../state/timeline.js';
import { renderCapture } from './capture.js';

const BOTTOM_SLACK_PX = 40;
const EVENT_TITLES = { edited: 'Edited at source', deleted: 'Deleted at source', conflicting_copy: 'Conflicting copy received' };
const view = { chatId: null, focusedMessageId: null };

function fact(label, value) {
  return [h('dt', { text: label }), h('dd', {}, [value instanceof Node ? value : h('span', { text: value })])];
}

function sourceFact(chat, captureMethod) {
  return fact('Source', `${chat.channelLabel}, ${CAPTURE_METHOD_LABELS[captureMethod] ?? captureMethod}`);
}

function messageText(text, missingText) {
  if (text === null || text === '') return h('p', { className: 'message-missing', text: missingText });
  return h('p', { className: 'message-text', dir: 'auto', text });
}

function heading(message) {
  const composerSent = message.origin === 'officer_composer';
  const who = composerSent ? message.author?.displayName : (message.sender?.displayName ?? message.sender?.externalId);
  const direction = DIRECTION_LABELS[message.direction ?? 'unknown'];
  const parts = [h('strong', { text: composerSent ? `${direction} reply` : direction })];
  if (who) parts.push(h('span', { text: ' from ' }), bdi(who));
  if (!composerSent && message.direction === 'outgoing') parts.push(h('span', { text: ' (observed at the source)' }));
  return h('p', { className: 'entry-heading' }, parts);
}

/** The review line's classes; a completed review that recorded findings is marked so it reads like the finding it is. */
function reviewClass(review) {
  const findings = review.status === 'completed' && review.outcome === 'findings' ? ' review-findings' : '';
  return `review review-${review.status}${findings}`;
}

function evidenceStatus(capture, review, subject, ctx) {
  return h('div', { className: 'evidence-status' }, [
    capture === null ? null : renderCapture(capture, subject, ctx),
    review === null ? null : h('p', { className: reviewClass(review), text: reviewStatusLabel(review) }),
  ]);
}

function sendStatus(message) {
  return h('p', { className: 'send-status' }, [
    h('strong', { className: 'badge badge-simulated', text: message.sendStatusLabel ?? 'Not sent' }),
    h('span', { text: ' by ' }),
    bdi(message.author?.displayName ?? 'unknown officer'),
    h('span', { text: ', ' }),
    timeEl(message.receivedAt),
  ]);
}

function replyTargetControl(message, ctx) {
  const radio = h('input', { type: 'radio', name: 'reply-target', value: message.id, checked: ctx.replyTargetId === message.id, dataset: { focusKey: `target:${message.id}` } });
  radio.addEventListener('change', () => {
    if (radio.checked) ctx.handlers.onSelectReplyTarget(message.id);
  });
  return h('label', { className: 'reply-target' }, [radio, h('span', { text: 'Select this message' })]);
}

function messageFacts(message, chat) {
  const facts = [...sourceFact(chat, message.source.captureMethod), ...fact('Received', timeEl(message.receivedAt))];
  if (message.sentAt !== null) facts.push(...fact('Sent at source', timeEl(message.sentAt)));
  // The number a sender-metadata watchlist observation cites; shown as the source wrote it.
  const senderPhone = senderPhoneOf(message);
  if (senderPhone !== null) facts.push(...fact('Sender phone', bdi(senderPhone)));
  if (message.unsupportedContent.length > 0) facts.push(...fact('Not captured', message.unsupportedContent.join(', ')));
  return h('dl', { className: 'facts' }, facts);
}

function messageFlags(message) {
  const flags = [];
  if (message.editedAtSource) flags.push('Edited at source: the edit is a separate entry below.');
  if (message.deletedAtSource) flags.push('Deleted at source: the captured text stays available.');
  return flags.map((text) => h('p', { className: 'flag', text }));
}

function messageEntry(message, ctx) {
  const composerSent = message.origin === 'officer_composer';
  const direction = message.direction ?? 'unknown';
  const subject = `the ${direction} message received ${formatTime(message.receivedAt)}`;
  const missing = message.originalCaptured ? 'No text: unsupported content only.' : 'Original text not captured: first seen through an edit or deletion.';
  return h('article', {
    className: `entry message ${direction}`,
    id: `message-${message.id}`,
    tabIndex: -1,
    dataset: { kind: 'message', direction, origin: message.origin, messageId: message.id },
  }, [
    heading(message),
    messageText(message.text, missing),
    messageFacts(message, ctx.chat),
    ...messageFlags(message),
    composerSent ? sendStatus(message) : evidenceStatus(message.capture, message.review, subject, ctx),
    ctx.selecting && direction === 'incoming' && !composerSent ? replyTargetControl(message, ctx) : null,
  ]);
}

function eventEntry(event, ctx) {
  const title = EVENT_TITLES[event.type] ?? event.type;
  const facts = [...sourceFact(ctx.chat, event.captureMethod), ...fact('Received', timeEl(event.receivedAt))];
  if (event.sourceOccurredAt !== null) facts.push(...fact('At the source', timeEl(event.sourceOccurredAt)));
  const deleted = event.type === 'deleted';
  return h('article', { className: `entry message-event event-${event.type}`, dataset: { kind: 'message_event', eventType: event.type, messageId: event.messageId } }, [
    h('p', { className: 'entry-heading' }, [
      h('strong', { text: title }),
      h('span', { text: ' ' }),
      h('a', { href: chatHref(event.chatId, event.messageId), text: 'Go to the original message' }),
    ]),
    deleted ? h('p', { className: 'hint', text: 'Mirsad keeps the text and evidence it already captured.' }) : messageText(event.text, 'No text.'),
    h('dl', { className: 'facts' }, facts),
    deleted ? null : evidenceStatus(event.capture, event.review, `the ${title.toLowerCase()} event received ${formatTime(event.receivedAt)}`, ctx),
  ]);
}

function findingEntry(finding) {
  return h('aside', { className: `entry finding finding-${finding.kind}`, dataset: { kind: 'finding', findingId: finding.id }, 'aria-label': finding.label }, [
    h('p', { className: 'entry-heading' }, [h('strong', { text: finding.label })]),
    h('blockquote', { className: 'finding-quote', dir: 'auto', text: finding.quote }),
    finding.changedFrom === null ? null : h('p', { className: 'hint' }, [h('span', { text: 'Previously: ' }), bdi(finding.changedFrom)]),
    h('p', { className: 'finding-note', text: finding.note }),
    h('a', { href: chatHref(finding.chatId, finding.messageId), text: 'Go to the message' }),
  ]);
}

const RENDERERS = { message: messageEntry, message_event: eventEntry, finding: (finding) => findingEntry(finding) };

function artifactIdsOf(timeline) {
  const captures = [...timeline.messages, ...timeline.messageEvents].map((item) => item.capture);
  return new Set(captures.filter((capture) => capture !== null && capture.artifactId !== null).map((capture) => capture.artifactId));
}

function focusRequestedMessage(container, messageId) {
  if (messageId === null || messageId === view.focusedMessageId) return;
  const target = document.getElementById(`message-${messageId}`);
  if (!target || !container.contains(target)) return;
  view.focusedMessageId = messageId;
  target.classList.add('focused');
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
}

export function renderTimeline(container, state, handlers, captures) {
  const { timeline } = state;
  const sameChat = timeline !== null && timeline.chat.id === view.chatId;
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < BOTTOM_SLACK_PX;
  const scrollTop = container.scrollTop;
  withFocus(container, () => {
    clear(container);
    if (timeline === null) return;
    const ctx = { chat: timeline.chat, handlers, captures, selecting: canCompose(timeline.chat, state.me), replyTargetId: state.replyTargetId };
    const entries = timelineEntries(timeline).filter((entry) => entry.kind !== 'case_action');
    if (entries.length === 0) container.append(h('p', { className: 'placeholder', text: 'No messages observed yet.' }));
    for (const entry of entries) container.append(RENDERERS[entry.kind](entry.item, ctx));
    captures.retainOnly(artifactIdsOf(timeline));
  });
  if (!sameChat) view.focusedMessageId = null;
  view.chatId = timeline === null ? null : timeline.chat.id;
  container.scrollTop = sameChat && !atBottom ? scrollTop : container.scrollHeight;
  focusRequestedMessage(container, state.focusMessageId);
}
