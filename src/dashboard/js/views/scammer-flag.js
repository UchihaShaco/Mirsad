/**
 * Flag as scammer: the officer gives the contact's number and a reason. Only the number goes to the phone watchlist
 * (approved); the chat then lists under Suspects. The number and reason live only in the form controls.
 */
import { describeError } from '../format.js';
import { senderPhoneOf } from '../state/timeline.js';

/** The newest phone number the contact's own messages supplied as sender metadata, if any. */
function knownNumber(timeline) {
  for (const message of [...timeline.messages].reverse()) {
    const phone = senderPhoneOf(message);
    if (phone) return phone;
  }
  return '';
}

export function bindScammerFlag(ctx) {
  const { refs } = ctx;
  const { signal } = ctx.listeners;
  const options = { signal };
  let chatId = null;
  let generation = 0;

  function setBusy(busy) {
    refs.flagNumber.readOnly = busy;
    refs.flagReason.readOnly = busy;
    refs.flagSubmit.disabled = busy;
  }
  refs.openFlagScammer.addEventListener('click', () => {
    const { timeline, pending } = ctx.getState();
    if (!timeline || pending !== null) return;
    generation++;
    chatId = timeline.chat.id;
    refs.flagForm.reset();
    refs.flagStatus.textContent = '';
    refs.flagTarget.textContent = timeline.chat.displayLabel;
    refs.flagNumber.value = knownNumber(timeline);
    setBusy(false);
    refs.flagDialog.showModal();
    (refs.flagNumber.value ? refs.flagReason : refs.flagNumber).focus();
  }, options);
  refs.flagDialog.addEventListener('close', () => {
    if (refs.flagDialog.open) return;
    generation++;
    chatId = null;
    refs.flagForm.reset();
    refs.flagStatus.textContent = '';
  }, options);
  refs.flagForm.addEventListener('input', () => { refs.flagStatus.textContent = ''; }, options);
  refs.flagForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (refs.flagSubmit.disabled || chatId === null || ctx.getState().pending !== null) return;
    const requestGeneration = generation;
    const flagged = chatId;
    setBusy(true);
    refs.flagStatus.textContent = '';
    ctx.setState({ pending: 'flag_scammer', notice: null });
    try {
      const result = await ctx.api.flagScammer(flagged, refs.flagNumber.value.trim(), refs.flagReason.value.trim());
      if (signal.aborted || generation !== requestGeneration) return;
      refs.flagDialog.close();
      ctx.setState({ notice: { tone: 'info', text: result.created
        ? 'Flagged as a scammer. The number is approved on the phone watchlist and the chat is under Suspects.'
        : 'This contact was already flagged with that number.' } });
      ctx.refreshers.inbox.request();
      if (ctx.getState().selectedChatId === flagged) ctx.refreshers.timeline.request();
      if (ctx.getState().view === 'watchlist') ctx.refreshers.watchlist.request();
    } catch (error) {
      if (signal.aborted || generation !== requestGeneration) return;
      refs.flagStatus.textContent = error?.code === 'validation_failed'
        ? 'Enter the number with its country code and a reason of at least 3 characters.'
        : describeError(error);
      setBusy(false);
    } finally {
      if (!signal.aborted) ctx.setState({ pending: null });
    }
  }, options);
}
