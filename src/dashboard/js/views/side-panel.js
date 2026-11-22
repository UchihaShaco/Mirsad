/**
 * Beside the timeline: the chat's watchlist matches, its merchant confirmations with the form that records one, and
 * its internal case log, oldest first. Everything an officer or a source wrote is set as plain text.
 */
import { bdi, clear, h, timeEl } from '../dom.js';
import { AI_MODE_LABELS, CASE_ACTION_LABELS } from '../format.js';
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

function caseLogEntry(action) {
  const meta = [timeEl(action.occurredAt)];
  if (action.actor !== null) meta.unshift(bdi(action.actor.displayName), h('span', { text: ', ' }));
  return h('li', { className: 'case-log-entry', dataset: { actionType: action.type } }, [
    h('strong', { text: CASE_ACTION_LABELS[action.type] ?? action.type }),
    modeChange(action),
    h('span', { className: 'case-log-meta' }, meta),
    action.messageId === null ? null : h('a', { href: chatHref(action.chatId, action.messageId), text: 'Go to the message' }),
  ]);
}

export function renderSidePanel(refs, state) {
  clear(refs.matches);
  clear(refs.caseReferences);
  clear(refs.caseLog);
  const { timeline } = state;
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
