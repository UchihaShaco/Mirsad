/**
 * Composer state for a chat under takeover (pure; types in composer.d.ts). Every update returns the next state and at
 * most one request, and only an explicit send by the controlling officer produces one: inserting the acknowledgement
 * only fills the editable text. The service still enforces control and revision on the request itself.
 */

/** The composer is offered only while the chat is in officer control and the signed-in officer controls it. */
export function canCompose(chat, me) {
  return Boolean(me) && chat.aiMode === 'officer_control' && chat.controller !== null && chat.controller.id === me.id;
}

/** The service sets the acknowledgement template only on chats of an identified intake account. */
export function canInsertAcknowledgement(chat) {
  return chat.intakeAccount === true && typeof chat.acknowledgementTemplate === 'string' && chat.acknowledgementTemplate !== '';
}

export function canSend(state) {
  return !state.sending && state.text.trim() !== '';
}

export function initialComposer() {
  return { text: '', sending: false, pendingSend: null };
}

const unchanged = (state) => ({ state, request: null });

function isRetryOf(pending, chat, text) {
  return pending !== null && pending.chatId === chat.id && pending.text === text && pending.expectedRevision === chat.revision;
}

function send(state, { chat, me, newKey }) {
  if (!canSend(state) || !canCompose(chat, me)) return unchanged(state);
  const idempotencyKey = isRetryOf(state.pendingSend, chat, state.text) ? state.pendingSend.idempotencyKey : newKey;
  const request = { chatId: chat.id, text: state.text, expectedRevision: chat.revision, idempotencyKey };
  return { state: { ...state, sending: true, pendingSend: request }, request };
}

export function updateComposer(state, action) {
  switch (action.type) {
    case 'edit':
      return unchanged({ ...state, text: action.text });
    case 'insert_acknowledgement':
      return canInsertAcknowledgement(action.chat) ? unchanged({ ...state, text: action.chat.acknowledgementTemplate }) : unchanged(state);
    case 'send':
      return send(state, action);
    case 'send_failed':
      return unchanged({ ...state, sending: false });
    case 'send_succeeded':
    case 'reset':
      return unchanged(initialComposer());
    default:
      return unchanged(state);
  }
}
