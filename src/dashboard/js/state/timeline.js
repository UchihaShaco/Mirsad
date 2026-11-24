/**
 * The chat timeline as one ordered list (pure; types in timeline.d.ts). Every stored row carries the workspace stream
 * position issued when it was created, so messages, edits and deletions, findings and case actions share one order.
 */

/** Tie-break for equal positions (not expected, since positions are unique): evidence before what refers to it. */
const KIND_ORDER = { message: 0, message_event: 1, finding: 2, case_action: 3 };

function entriesOf(kind, items) {
  return items.map((item) => ({ kind, id: item.id, position: item.position, item }));
}

function compareEntries(a, b) {
  if (a.position !== b.position) return a.position - b.position;
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function timelineEntries(timeline) {
  return [
    ...entriesOf('message', timeline.messages),
    ...entriesOf('message_event', timeline.messageEvents),
    ...entriesOf('finding', timeline.findings),
    ...entriesOf('case_action', timeline.caseActions),
  ].sort(compareEntries);
}

const isIncomingSource = (message) => message.direction === 'incoming' && message.origin === 'source';

/** An edit or late finding belongs to the test in which its source message was captured. */
export function timelineForPeriod(timeline, previous) {
  const marker = timeline.testSession;
  if (!marker) return timeline;
  const oldMessages = new Set(marker.previousMessageIds);
  const oldReferences = new Set(marker.previousReferenceIds);
  return {
    ...timeline,
    messages: timeline.messages.filter(m => oldMessages.has(m.id) === previous),
    messageEvents: timeline.messageEvents.filter(e => oldMessages.has(e.messageId) === previous),
    findings: timeline.findings.filter(f => oldMessages.has(f.messageId) === previous),
    caseActions: timeline.caseActions.filter(a => a.type !== 'chat_test_started'
      && (oldMessages.has(a.messageId) || oldMessages.has(a.detail?.inReplyTo) || a.position < marker.position) === previous),
    caseReferences: timeline.caseReferences.filter(r => oldReferences.has(r.id) === previous),
  };
}

/** The newest incoming message from the source: the default selection for Leave unanswered. */
export function latestIncomingMessageId(timeline) {
  let latest = null;
  for (const message of timeline.messages) {
    if (!isIncomingSource(message)) continue;
    if (latest === null || message.position > latest.position) latest = message;
  }
  return latest === null ? null : latest.id;
}

/**
 * The phone the source supplied as sender metadata of an incoming message, exactly as written, or null. A service from
 * before the field existed sends no phone, which also gives null.
 */
export function senderPhoneOf(message) {
  const phone = message.direction === 'incoming' ? message.sender?.phone : null;
  return typeof phone === 'string' && phone.trim() !== '' ? phone : null;
}

/**
 * The Leave unanswered target after a timeline reload. Until the officer picks a message (`pinned`), the target follows
 * the newest incoming message on every reload; a picked message stays the target while it is in the timeline.
 */
export function replyTargetAfterReload(target, timeline) {
  const kept = target.pinned && timeline.messages.some((message) => message.id === target.id && isIncomingSource(message));
  return kept ? target : { id: latestIncomingMessageId(timeline), pinned: false };
}
