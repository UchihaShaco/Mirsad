/**
 * The takeover composer, shown only to the officer who controls the chat. It starts blank. Send makes the one request;
 * Insert acknowledgement (intake accounts only) fills the editable text and sends nothing; Leave unanswered records a
 * case action for the selected incoming message.
 */
import { formatTime } from '../format.js';
import { canCompose, canInsertAcknowledgement, canSend } from '../state/composer.js';

export function bindComposer(refs, handlers, signal) {
  refs.composerText.addEventListener('input', () => handlers.onComposerInput(refs.composerText.value), { signal });
  refs.insertAcknowledgement.addEventListener('click', () => handlers.onInsertAcknowledgement(), { signal });
  refs.sendButton.addEventListener('click', () => handlers.onSend(), { signal });
  refs.leaveUnansweredButton.addEventListener('click', () => handlers.onLeaveUnanswered(), { signal });
}

function describeTarget(state) {
  const target = state.timeline.messages.find((message) => message.id === state.replyTargetId);
  if (!target) return 'Select an incoming message in the timeline to leave it unanswered.';
  return `Leave unanswered applies to the incoming message received ${formatTime(target.receivedAt)}.`;
}

export function renderComposer(refs, state) {
  const chat = state.timeline === null ? null : state.timeline.chat;
  const offered = chat !== null && canCompose(chat, state.me);
  refs.composer.hidden = !offered;
  if (!offered) return;
  if (refs.composerText.value !== state.composer.text) refs.composerText.value = state.composer.text;
  const busy = state.pending !== null || state.composer.sending;
  refs.composerText.readOnly = state.composer.sending;
  refs.sendButton.disabled = busy || !canSend(state.composer);
  refs.insertAcknowledgement.hidden = !canInsertAcknowledgement(chat);
  refs.insertAcknowledgement.disabled = busy;
  refs.leaveUnansweredButton.disabled = busy || state.replyTargetId === null;
  refs.replyTarget.textContent = describeTarget(state);
}
