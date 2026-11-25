/**
 * The selected chat's timeline: messages in both directions with source, capture method, receipt time, capture and
 * review status; edits, deletions and conflicting copies as their own entries; findings as one compact note each. Case
 * actions go to the case log beside it. Message text is plain text in a dir="auto" element. An entry that is the source
 * of evidence for officer review carries that reason, so the message that explains an interruption stands out.
 */
import { bdi, clear, h, timeEl, withFocus } from '../dom.js';
import {
  CAPTURE_METHOD_LABELS, DIRECTION_LABELS, formatClock, formatDay, formatTime, PHONE_VERDICT_LABELS, REPORT_CHANNEL_LABELS, REPORT_REASON_LABELS,
  reviewWarningLabel, reviewStatusLabel, silenceExplanation, silenceSummary, TELEGRAM_EVIDENCE_LABELS,
} from '../format.js';
import { evidenceSources } from '../state/attention.js';
import { canCompose } from '../state/composer.js';
import { chatHref, placesHref } from '../state/route.js';
import { senderPhoneOf, timelineEntries } from '../state/timeline.js';
import { renderCapture } from './capture.js';

const BOTTOM_SLACK_PX = 40;
const EVENT_TITLES = { edited: 'Edited at source', deleted: 'Deleted at source', conflicting_copy: 'Conflicting copy received' };
const view = { chatId: null, focusedEntry: null };

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

/** Who wrote the message, then how it reached the timeline. */
function heading(message, replySource) {
  const composerSent = message.origin === 'officer_composer';
  const who = composerSent ? message.author?.displayName : (message.sender?.displayName ?? message.sender?.externalId);
  const direction = DIRECTION_LABELS[message.direction ?? 'unknown'];
  let role = direction;
  if (replySource) role = `${direction} automated reply`;
  else if (composerSent) role = `${direction} reply`;
  else if (message.direction === 'outgoing') role = `${direction}, observed at the source`;
  return h('p', { className: 'entry-heading' }, [
    who ? h('strong', { className: 'entry-who' }, [bdi(who)]) : null,
    h('span', { className: 'entry-role', text: role }),
  ]);
}

function entryTop(label, receivedAt) {
  const fullTime = formatTime(receivedAt);
  return h('div', { className: 'message-top' }, [
    label, h('time', { className: 'message-time', datetime: receivedAt, title: fullTime, 'aria-label': fullTime, text: formatClock(receivedAt) }),
  ]);
}

/** The review line's classes; a completed review that recorded findings is marked so it reads like the finding it is. */
function reviewClass(review) {
  const findings = review.status === 'completed' && review.outcome === 'findings' ? ' review-findings' : '';
  return `review review-${review.status}${findings}`;
}

function reviewLine(review) {
  return review ? h('p', { className: reviewClass(review), text: reviewStatusLabel(review) }) : null;
}

/** Failed captures and reviews need attention even while the routine provenance is folded away. */
function captureAndDetails(key, facts, capture, review, subject, ctx) {
  const reviewWarning = review?.status === 'unavailable' || review?.status === 'stale_discarded';
  const failed = capture?.status === 'failed';
  const details = h('details', { className: 'message-details', open: ctx.openDetails.has(key), dataset: { detailKey: key } }, [
    h('summary', { text: 'Message details', dataset: { focusKey: `details:${key}` } }),
    facts, reviewWarning ? null : reviewLine(review),
  ]);
  if (capture && !failed) {
    let loaded = false;
    const showCapture = () => {
      if (details.open && !loaded) {
        loaded = true;
        details.append(renderCapture(capture, subject, ctx));
      }
    };
    // Restore open controls before withFocus runs. A queued native toggle may outlive an old timeline render.
    showCapture();
    details.addEventListener('toggle', () => { if (details.isConnected) showCapture(); });
  }
  return [failed ? renderCapture(capture, subject, ctx) : null, reviewWarning ? reviewLine(review) : null, details];
}

function replyTargetControl(message, ctx) {
  const radio = h('input', { type: 'radio', name: 'reply-target', value: message.id, checked: ctx.replyTargetId === message.id, dataset: { focusKey: `target:${message.id}` } });
  radio.addEventListener('change', () => {
    if (radio.checked) ctx.handlers.onSelectReplyTarget(message.id);
  });
  return h('label', { className: 'reply-target' }, [radio, h('span', { text: 'Select this message' })]);
}

function messageFacts(message, chat, replySource, ctx) {
  const facts = [...sourceFact(chat, message.source.captureMethod), ...fact('Received', timeEl(message.receivedAt))];
  if (replySource) facts.push(...fact('Automated reply', replySource));
  if (message.sentAt !== null) facts.push(...fact('Sent at source', timeEl(message.sentAt)));
  // The number a sender-metadata watchlist observation cites; shown as the source wrote it.
  const senderPhone = senderPhoneOf(message);
  if (senderPhone !== null) {
    facts.push(...fact('Sender phone', h('span', { className: 'artifact-check' }, [bdi(senderPhone), ctx ? placesCheck(senderPhone, ctx) : null])));
  }
  return h('dl', { className: 'facts' }, facts);
}

function messageFlags(message) {
  const flags = [];
  if (message.editedAtSource) flags.push('Edited at source: the edit is a separate entry below.');
  if (message.deletedAtSource) flags.push('Deleted at source: the captured text stays available.');
  return flags.map((text) => h('p', { className: 'flag', text }));
}

/**
 * Why this entry matters to the open review, one line per reason: the payment link the model flagged, material that
 * holds replies until it is reviewed, or material that was captured while replies continue.
 */
function sourceMarkers(sourceId, ctx) {
  const reasons = new Map((ctx.evidenceSources.get(sourceId) ?? []).map((source) => [source.reason, source]));
  return [...reasons.values()].map(({ reason, blocking }) => {
    const warning = reviewWarningLabel(reason);
    if (warning) return h('p', { className: 'evidence-warning', text: warning });
    const subject = `shared ${TELEGRAM_EVIDENCE_LABELS[reason] ?? 'item'}`;
    return h('p', { className: 'source-marker', dataset: { blocking: String(blocking) } }, [
      h('strong', { text: blocking ? 'Review required' : 'Captured' }),
      h('span', { text: `: ${subject}` }),
    ]);
  });
}

/** The entry's part in the open review, for its outline: holding replies, captured, or none. */
function evidenceRole(sourceId, ctx) {
  const sources = ctx.evidenceSources.get(sourceId);
  if (!sources) return 'none';
  return sources.some((source) => source.blocking) ? 'blocking' : 'captured';
}

function meetingAgreement(sourceId, ctx) {
  return sourceId === ctx.meetingSource ? h('p', { className: 'lower-concern-badge',
    text: ctx.previous ? 'Previous test · Lower concern · Meeting agreed' : 'Lower concern · Meeting agreed' }) : null;
}

/** Whose words these are, for the entry's colour: the contact, the automated reply, an officer, or the account itself. */
function authorOf(message, replySource) {
  if (message.origin === 'officer_composer') return 'officer';
  if (replySource) return 'ai';
  return message.direction === 'outgoing' ? 'account' : 'contact';
}

/** Answers survive a re-render of the timeline: keyed by the value checked. */
const placesChecks = new Map();
const humanCategory = (category) => category.replace(/_/g, ' ');

function placesAnswer(value, answer) {
  if (answer.status === 'pending') return h('span', { className: 'places-answer', role: 'status', text: 'Checking Places…' });
  if (answer.status === 'error') return h('span', { className: 'places-answer error', role: 'status', text: 'Places could not be checked.' });
  if (answer.status === 'no_directory') return h('span', { className: 'places-answer', role: 'status', text: 'The Places directory is not loaded on this portal.' });
  if (answer.status === 'not_listed') return h('span', { className: 'places-answer', role: 'status', text: 'Not listed for any business in Places.' });
  const [first] = answer.places;
  const more = answer.total > 1 ? ` and ${answer.total - 1} more` : '';
  return h('span', { className: 'places-answer places-listed', role: 'status' }, [
    document.createTextNode('Listed in Places: '), bdi(first.name), document.createTextNode(` (${humanCategory(first.category)})${more}. `),
    h('a', { href: placesHref(value), text: 'Show on map', dataset: { focusKey: `places:${value}` } }),
  ]);
}

/** Whose number or website this is, from the Places directory; asked only when the officer clicks. */
function placesCheck(value, ctx) {
  const answer = placesChecks.get(value);
  if (answer) return placesAnswer(value, answer);
  const button = h('button', { type: 'button', className: 'quiet places-check', text: 'Check in Places',
    'aria-label': `Check ${value} in Places`, dataset: { focusKey: `places-check:${value}` } });
  button.addEventListener('click', async () => {
    const slot = button.parentElement;
    placesChecks.set(value, { status: 'pending' });
    button.replaceWith(placesAnswer(value, { status: 'pending' }));
    let result;
    try { result = await ctx.handlers.onCheckPlaces(value); } catch { result = { status: 'error' }; }
    placesChecks.set(value, result);
    // A re-render may have replaced the row meanwhile; it reads the stored answer.
    slot?.querySelector('.places-answer')?.replaceWith(placesAnswer(value, result));
    if (result.status === 'error') placesChecks.delete(value);
  });
  return button;
}

/** What the citizen's phone decided and found, from the report. Links are shown as text and never opened. */
function reportDetails(report, ctx) {
  if (!report) return null;
  const a = report.artifacts;
  const groups = [
    ['Links', a.urls], ['Domains', a.domains], ['IBANs', a.ibans], ['Phone numbers', [a.senderType === 'NUMBER' ? a.sender : null, ...a.phones].filter(Boolean)],
    ['Emails', a.emails], ['Wallets', a.wallets], ['Handles', a.handles],
  ].filter(([, values]) => values.length > 0);
  return h('section', { className: 'report-details', dataset: { level: report.level.toLowerCase() }, 'aria-label': 'Citizen report details' }, [
    h('p', { className: 'report-verdict-line' }, [
      h('strong', { className: `report-verdict verdict-${report.level.toLowerCase()}`, text: PHONE_VERDICT_LABELS[report.level] }),
      h('span', { text: `Risk ${Math.round(report.score * 100)}% · ${REPORT_CHANNEL_LABELS[report.channel]}` }),
      report.demo ? h('span', { className: 'demo-chip', text: 'Demo' }) : null,
    ]),
    report.reasonCodes.length ? h('ul', { className: 'report-reasons', 'aria-label': 'Why the phone decided this' },
      report.reasonCodes.filter(code => code !== 'MODEL_SCORE').map(code => h('li', { text: REPORT_REASON_LABELS[code] ?? code }))) : null,
    groups.length ? h('dl', { className: 'report-artifacts' }, groups.flatMap(([label, values]) => [
      h('dt', { text: label }),
      h('dd', {}, values.map(value => (label === 'Phone numbers' || label === 'Domains')
        ? h('span', { className: 'artifact-check' }, [h('bdi', { dir: 'ltr', text: value }), placesCheck(value, ctx)])
        : h('bdi', { dir: 'ltr', text: value }))),
    ])) : null,
    h('p', { className: 'hint report-provenance' }, [
      h('span', { text: `Report ${report.reportId} · shared ${formatTime(report.createdAt)} · imported ${formatTime(report.importedAt)}` }),
      report.importedBy ? h('span', {}, [document.createTextNode(' by '), bdi(report.importedBy.displayName)]) : null,
    ]),
  ]);
}

function messageEntry(message, ctx) {
  const composerSent = message.origin === 'officer_composer';
  const direction = message.direction ?? 'unknown';
  const replySource = ctx.replySources.get(message.id);
  const skipped = direction === 'incoming' && ctx.skippedReasons.get(message.id);
  const subject = `the ${direction} message received ${formatTime(message.receivedAt)}`;
  const missing = message.originalCaptured ? 'No text: unsupported content only.' : 'Original text not captured: first seen through an edit or deletion.';
  return h('article', {
    className: `entry message ${direction}`,
    id: `message-${message.id}`,
    tabIndex: -1,
    dataset: {
      kind: 'message', direction, origin: message.origin, messageId: message.id, focusKey: `message:${message.id}`,
      author: authorOf(message, replySource), evidence: evidenceRole(message.id, ctx),
    },
  }, [
    entryTop(heading(message, replySource), message.receivedAt),
    messageText(message.text, missing),
    reportDetails(ctx.reports.get(message.id), ctx),
    ...sourceMarkers(message.id, ctx),
    meetingAgreement(message.id, ctx),
    skipped ? h('div', { className: 'skipped-reply' }, [
      h('p', {}, [h('strong', { text: 'No automated reply. ' }), h('span', { text: skipped.reason })]),
      skipped.why ? h('p', { className: 'skipped-why' }, [h('span', { className: 'why-label', text: 'Why: ' }), h('q', { dir: 'auto', text: skipped.why })]) : null,
    ]) : null,
    ...messageFlags(message),
    message.unsupportedContent.length ? h('p', { className: 'hint', text: `Not captured: ${message.unsupportedContent.join(', ')}` }) : null,
    composerSent ? h('p', { className: 'send-status' }, [
      h('strong', { className: 'badge badge-simulated', text: message.sendStatusLabel ?? 'Not sent' }),
    ]) : null,
    ctx.selecting && direction === 'incoming' && !composerSent ? replyTargetControl(message, ctx) : null,
    ...captureAndDetails(`message:${message.id}`, messageFacts(message, ctx.chat, replySource, ctx), message.capture, message.review, subject, ctx),
  ]);
}

function eventEntry(event, ctx) {
  const title = EVENT_TITLES[event.type] ?? event.type;
  const facts = [...sourceFact(ctx.chat, event.captureMethod), ...fact('Received', timeEl(event.receivedAt))];
  if (event.sourceOccurredAt !== null) facts.push(...fact('At the source', timeEl(event.sourceOccurredAt)));
  const deleted = event.type === 'deleted';
  return h('article', {
    className: `entry message-event event-${event.type}`, id: `event-${event.id}`, tabIndex: -1,
    dataset: { kind: 'message_event', eventType: event.type, messageId: event.messageId, focusKey: `event:${event.id}`, evidence: evidenceRole(event.id, ctx) },
  }, [
    entryTop(h('p', { className: 'entry-heading' }, [
      h('strong', { text: title }),
      h('span', { text: ' ' }),
      h('a', { href: chatHref(event.chatId, event.messageId), text: 'Go to the original message', dataset: { focusKey: `original:${event.id}` } }),
    ]), event.receivedAt),
    deleted ? h('p', { className: 'hint', text: 'Mirsad keeps the text and evidence it already captured.' }) : messageText(event.text, 'No text.'),
    ...sourceMarkers(event.id, ctx),
    meetingAgreement(event.id, ctx),
    ...captureAndDetails(`event:${event.id}`, h('dl', { className: 'facts' }, facts),
      deleted ? null : event.capture, deleted ? null : event.review, `the ${title.toLowerCase()} event received ${formatTime(event.receivedAt)}`, ctx),
  ]);
}

function findingEntry(finding) {
  return h('aside', { className: `entry finding finding-${finding.kind}`, dataset: { kind: 'finding', findingId: finding.id }, 'aria-label': finding.label }, [
    h('p', { className: 'entry-heading' }, [h('strong', { text: finding.label })]),
    h('blockquote', { className: 'finding-quote', dir: 'auto', text: finding.quote }),
    finding.changedFrom === null ? null : h('p', { className: 'hint' }, [h('span', { text: 'Previously: ' }), bdi(finding.changedFrom)]),
    h('p', { className: 'finding-note', text: finding.note }),
    h('a', { href: chatHref(finding.chatId, finding.messageId), text: 'Go to the message', dataset: { focusKey: `finding:${finding.id}` } }),
  ]);
}

const RENDERERS = { message: messageEntry, message_event: eventEntry, finding: (finding) => findingEntry(finding) };
/** When each entry reached Mirsad, for the day headings; a finding stays under the day of the entry before it. */
const RECEIVED_AT = { message: (item) => item.receivedAt, message_event: (item) => item.receivedAt, finding: () => null };

/** Each send keeps its model attribution even after the configured provider changes. */
function replySourcesOf(timeline) {
  return new Map(timeline.caseActions
    .filter(action => action.type === 'ai_reply_sent' && action.messageId !== null)
    .map(action => {
      const detail = action.detail;
      if (detail?.source === 'consent_notice') return [action.messageId, 'consent prompt'];
      if (detail?.source === 'fixed') return [action.messageId, 'fixed wording'];
      return [action.messageId, detail?.model ? `written by ${detail.model}` : 'written by the local model'];
    }));
}

function artifactIdsOf(timeline) {
  const captures = [...timeline.messages, ...timeline.messageEvents].map((item) => item.capture);
  return new Set(captures.filter((capture) => capture !== null && capture.artifactId !== null).map((capture) => capture.artifactId));
}

function focusRequestedMessage(container, messageId, eventId) {
  if (messageId === null) {
    view.focusedEntry = null;
    return;
  }
  const event = eventId ? document.getElementById(`event-${eventId}`) : null;
  // Original captures render as messages; subsequent edits have their own timeline entries.
  const target = event?.dataset.messageId === messageId ? event : document.getElementById(`message-${messageId}`);
  if (!target || !container.contains(target)) return;
  target.classList.add('focused');
  if (target.id === view.focusedEntry) return;
  view.focusedEntry = target.id;
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
}

export function renderTimeline(container, state, handlers, captures) {
  const { timeline } = state;
  const sameChat = timeline !== null && timeline.chat.id === view.chatId;
  const openDetails = new Set(sameChat ? [...container.querySelectorAll('.message-details[open]')].map(node => node.dataset.detailKey) : []);
  const focusedEntryId = sameChat && container.contains(document.activeElement) ? document.activeElement.closest('article')?.id : null;
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < BOTTOM_SLACK_PX;
  const scrollTop = container.scrollTop;
  withFocus(container, () => {
    clear(container);
    if (timeline === null) return;
    const agreement = (state.previous ? timeline.chat.previousLowerConcern : timeline.chat.lowerConcern)?.sources.agreement;
    const ctx = {
      chat: timeline.chat,
      openDetails,
      handlers,
      captures,
      selecting: !state.previous && canCompose(timeline.chat, state.me),
      replyTargetId: state.replyTargetId,
      replySources: replySourcesOf(timeline),
      reports: new Map((timeline.citizenReports ?? []).map(report => [report.messageId, report])),
      evidenceSources: evidenceSources(timeline),
      previous: state.previous,
      meetingSource: timeline.messageEvents.some(e => e.id === agreement?.messageEventId) ? agreement.messageEventId : agreement?.messageId,
      skippedReasons: new Map(timeline.caseActions
        .filter(action => action.type === 'ai_reply_skipped' && action.messageId !== null)
        .map(action => [action.messageId, { reason: silenceSummary(action.detail), why: silenceExplanation(action.detail) }])),
    };
    const entries = timelineEntries(timeline).filter((entry) => entry.kind !== 'case_action');
    if (entries.length === 0) container.append(h('p', { className: 'placeholder', text:
      timeline.testSession && !state.previous ? 'Waiting for the first message in this test.' : 'No messages observed yet.' }));
    let day = '';
    for (const entry of entries) {
      const received = RECEIVED_AT[entry.kind](entry.item);
      if (received && received.slice(0, 10) !== day) {
        day = received.slice(0, 10);
        container.append(h('h3', { className: 'day-divider' }, [h('time', { datetime: day, text: formatDay(received) }), h('span', { text: ' · times in UTC' })]));
      }
      container.append(RENDERERS[entry.kind](entry.item, ctx));
    }
    captures.retainOnly(artifactIdsOf(timeline));
  });
  // A successful capture retry removes its button. Keep the officer at the evidence they acted on.
  if (focusedEntryId && document.activeElement === document.body) {
    const summary = document.getElementById(focusedEntryId)?.querySelector('.message-details > summary');
    summary?.focus({ preventScroll: true });
  }
  if (!sameChat) view.focusedEntry = null;
  view.chatId = timeline === null ? null : timeline.chat.id;
  container.scrollTop = sameChat && !atBottom ? scrollTop : container.scrollHeight;
  focusRequestedMessage(container, state.focusMessageId, state.focusEventId);
}
