/** Beside the timeline: the chat's watchlist matches and its internal case log, oldest first. */
import { bdi, clear, h, timeEl } from '../dom.js';
import { AI_MODE_LABELS, CASE_ACTION_LABELS } from '../format.js';
import { chatHref } from '../state/route.js';
import { matchList } from './matches.js';

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
  clear(refs.caseLog);
  const { timeline } = state;
  if (timeline === null) {
    refs.matches.append(h('p', { className: 'hint', text: 'No chat selected.' }));
    refs.caseLog.append(h('li', { className: 'empty', text: 'No chat selected.' }));
    return;
  }
  const matches = timeline.chat.watchlistMatches;
  refs.matches.append(matches.length > 0 ? matchList(matches) : h('p', { className: 'hint', text: 'No watchlist match for this chat.' }));
  const actions = [...timeline.caseActions].sort((a, b) => a.position - b.position);
  if (actions.length === 0) refs.caseLog.append(h('li', { className: 'empty', text: 'Nothing recorded yet.' }));
  for (const action of actions) refs.caseLog.append(caseLogEntry(action));
}
