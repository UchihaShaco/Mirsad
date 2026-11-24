/**
 * Beside the timeline: the chat's watchlist matches, its merchant confirmations with the form that records one, and
 * its internal case log, oldest first. Everything an officer or a source wrote is set as plain text.
 */
import { bdi, clear, h, timeEl, withFocus } from '../dom.js';
import { AI_MODE_LABELS, AI_REPLY_FAILURE_NOTES, CASE_ACTION_LABELS, conversationReviewSummary, reviewWarningLabel, silenceExplanation, silenceSummary, TELEGRAM_EVIDENCE_LABELS } from '../format.js';
import { caseReferenceRequest } from '../state/case-reference.js';
import { chatHref } from '../state/route.js';
import { matchList } from './matches.js';

export function bindCaseReferenceForm(refs, handlers, signal) {
  const draft = () => ({ hosts: refs.caseReferenceHosts.value, note: refs.caseReferenceNote.value });
  refs.caseReferenceHosts.addEventListener('input', () => handlers.onCaseReferenceInput(draft()), { signal });
  refs.caseReferenceNote.addEventListener('input', () => handlers.onCaseReferenceInput(draft()), { signal });
  refs.caseReferenceForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handlers.onRecordCaseReference();
  }, { signal });
}

/** The form is offered for any open chat; Record stays disabled until the draft is complete. */
export function renderCaseReferenceForm(refs, state) {
  refs.caseReferenceForm.hidden = state.timeline === null;
  if (state.timeline === null) return;
  const { hosts, note } = state.caseReferenceDraft;
  if (refs.caseReferenceHosts.value !== hosts) refs.caseReferenceHosts.value = hosts;
  if (refs.caseReferenceNote.value !== note) refs.caseReferenceNote.value = note;
  refs.caseReferenceSubmit.disabled = state.pending !== null || caseReferenceRequest(state.caseReferenceDraft) === null;
}

function caseReferenceEntry(reference) {
  return h('li', { className: 'case-reference', dataset: { caseReferenceId: reference.id } }, [
    h('p', {}, [h('strong', { text: 'Payment hosts: ' }), bdi(reference.paymentHosts.join(', '))]),
    h('p', { className: 'case-reference-note', dir: 'auto', text: reference.sourceNote }),
    h('span', { className: 'case-log-meta' }, [bdi(reference.recordedBy.displayName), h('span', { text: ', ' }), timeEl(reference.recordedAt)]),
  ]);
}

function modeChange(action) {
  if (action.fromMode === null || action.toMode === null || action.fromMode === action.toMode) return null;
  return h('span', { className: 'case-log-meta', text: `${AI_MODE_LABELS[action.fromMode]} to ${AI_MODE_LABELS[action.toMode]}` });
}

/** Which model wrote an AI reply, or why one was not sent (codes only; the case log never holds message text). */
function aiReplyNote(action) {
  const detail = action.detail ?? {};
  if (action.type === 'lower_concern_assessed') {
    const sources = {};
    for (const role of ['agreement', 'time', 'place', 'date']) {
      const messageId = detail[role + 'MessageId'], messageEventId = detail[role + 'EventId'];
      if (typeof messageId === 'string' && typeof messageEventId === 'string') sources[role] = { messageId, messageEventId };
    }
    return meetingSources(action.chatId, sources, action.id, false);
  }
  if (action.type === 'ai_reply_skipped') {
    const why = silenceExplanation(detail);
    return h('span', { className: 'case-log-meta' }, [
      h('span', { text: silenceSummary(detail) }),
      why ? h('span', { className: 'case-log-why' }, [h('span', { className: 'why-label', text: ' Why: ' }), h('q', { dir: 'auto', text: why })]) : null,
    ]);
  }
  if (action.type === 'telegram_officer_review_requested') {
    const text = detail.reason === 'conversation_review' ? conversationReviewSummary(detail)
      : detail.reason === 'model_payment_link' ? 'Ali flagged an unverified payment request.'
      : `Shared ${TELEGRAM_EVIDENCE_LABELS[detail.reason] ?? 'item'}`;
    return h('span', { className: 'case-log-meta', text });
  }
  if (action.type === 'ai_reply_sent' && detail.source === 'consent_notice') {
    return h('span', { className: 'case-log-meta', text: 'Sent the consent prompt.' });
  }
  if (action.type === 'ai_reply_sent' && detail.source === 'fixed') {
    return h('span', { className: 'case-log-meta', text: 'Used a fixed reply.' });
  }
  if (action.type === 'ai_reply_sent' && typeof detail.model === 'string') {
    return h('span', { className: 'case-log-meta', text: `Written by ${detail.model}` });
  }
  if (action.type === 'ai_reply_failed' && typeof detail.code === 'string') {
    return h('span', { className: 'case-log-meta', text: aiReplyFailureText(detail) });
  }
  return null;
}

function meetingSources(chatId, sources, focusScope, showExplanation) {
  const roles = [{ key: 'agreement', label: 'Agreement' }, { key: 'time', label: 'Time' },
    { key: 'place', label: 'Location' }, { key: 'date', label: 'Date' }];
  return h('div', { className: 'meeting-evidence' }, [
    showExplanation ? h('p', { text: 'The seller agreed to meet. This provisional assessment reflects the conversation so far.' }) : null,
    h('ul', {}, roles.filter(role => sources[role.key]).map(({ key, label }) => h('li', {}, [h('a', {
      href: chatHref(chatId, sources[key].messageId, sources[key].messageEventId), text: label,
      dataset: { focusKey: `meeting:${focusScope}:${key}` },
    })]))),
    !sources.date && showExplanation ? h('p', { className: 'hint', text: 'No explicit date cited.' }) : null,
  ]);
}

function aiReplyFailureText(detail) {
  if (detail.code === 'store_failed' && detail.telegramMessageId != null) {
    return 'Telegram confirmed the send. Mirsad could not save the reply. Check Telegram before retrying.';
  }
  const note = Object.hasOwn(AI_REPLY_FAILURE_NOTES, detail.code) ? AI_REPLY_FAILURE_NOTES[detail.code] : null;
  const rule = typeof detail.rule === 'string' ? ` (${detail.rule})` : '';
  if (note !== null) return `${note}${rule}.`;
  const status = typeof detail.status === 'number' ? ` (${detail.status})` : '';
  return `Reason: ${detail.code}${status}`;
}

function caseLogEntry(action) {
  const meta = [timeEl(action.occurredAt)];
  const warning = action.type === 'telegram_officer_review_requested' && reviewWarningLabel(action.detail?.reason);
  if (action.actor !== null) meta.unshift(bdi(action.actor.displayName), h('span', { text: ', ' }));
  return h('li', { className: 'case-log-entry', dataset: { actionType: action.type } }, [
    h('strong', { text: warning ? `${warning} recorded` : CASE_ACTION_LABELS[action.type] ?? action.type }),
    modeChange(action),
    aiReplyNote(action),
    h('span', { className: 'case-log-meta' }, meta),
    action.messageId === null || action.type === 'lower_concern_assessed' ? null : h('a', {
      href: chatHref(action.chatId, action.messageId, action.detail?.messageEventId), text: 'Go to the message',
      dataset: { focusKey: `case-action:${action.id}` },
    }),
  ]);
}

function drawSidePanel(refs, state) {
  clear(refs.matches);
  clear(refs.caseReferences);
  clear(refs.caseLog);
  clear(refs.meetingSources);
  const { timeline } = state;
  // Where the panel covers the conversation, its heading still says whose case this is.
  refs.evidenceChatLabel.textContent = timeline?.chat.displayLabel ?? '';
  const assessment = state.previous ? timeline?.chat.previousLowerConcern : timeline?.chat.lowerConcern;
  refs.assessmentPanel.hidden = !assessment;
  if (assessment) refs.meetingSources.append(meetingSources(timeline.chat.id, assessment.sources, 'summary', true));
  if (timeline === null) {
    refs.matches.append(h('p', { className: 'hint', text: 'No chat selected.' }));
    refs.caseReferences.append(h('li', { className: 'empty', text: 'No chat selected.' }));
    refs.caseLog.append(h('li', { className: 'empty', text: 'No chat selected.' }));
    return;
  }
  const matches = timeline.chat.watchlistMatches;
  refs.matches.append(matches.length > 0 ? matchList(matches) : h('p', { className: 'hint', text: 'No watchlist match for this chat.' }));
  if (timeline.caseReferences.length === 0) refs.caseReferences.append(h('li', { className: 'empty', text: 'None recorded for this chat.' }));
  for (const reference of timeline.caseReferences) refs.caseReferences.append(caseReferenceEntry(reference));
  const actions = [...timeline.caseActions].sort((a, b) => a.position - b.position);
  if (actions.length === 0) refs.caseLog.append(h('li', { className: 'empty', text: 'Nothing recorded yet.' }));
  for (const action of actions) refs.caseLog.append(caseLogEntry(action));
}

export function renderSidePanel(refs, state) {
  const hadSourceFocus = state.evidenceOpen && refs.sidePanel.contains(document.activeElement)
    && document.activeElement.matches('a[data-focus-key]');
  withFocus(refs.sidePanel, () => drawSidePanel(refs, state));
  // A watchlist match may disappear while its source link has keyboard focus.
  if (hadSourceFocus && document.activeElement === document.body) refs.closeEvidence.focus({ preventScroll: true });
}
