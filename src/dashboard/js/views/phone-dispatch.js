/** The number and briefing live only in form controls. Only an officer's explicit draft handoff opens Telegram. */
import { describeError } from '../format.js';
import { chatHref } from '../state/route.js';

// The server rejects ambiguous international numbers, including changes to the digits during normalization.
// Convert the validated input to the ASCII digits required by Telegram's documented phone-number link.
function telegramRecipient(raw) {
  const ascii = raw.replace(/[٠-٩۰-۹]/g, char => String(char.charCodeAt(0) & 15));
  const digits = ascii.replace(/\D/g, '').replace(/^00/, '');
  return /^[1-9]\d{1,14}$/.test(digits) ? '+' + digits : '';
}

function receipt(status) {
  if (status === 'requires_resume') return 'This chat is paused or under officer control. Open the conversation to review its controls.';
  if (status === 'already_active') return 'The verified conversation is already active. Delivery depends on an eligible incoming message.';
  return 'Dispatch accepted for the verified conversation. Ali can reply when there is an eligible incoming message.';
}

export function bindPhoneDispatch(ctx, openOpener) {
  const { refs } = ctx;
  const { signal } = ctx.listeners;
  const options = { signal };
  let generation = 0;
  let retryKey = null;
  let manualRecipient = '';

  function resetResult() {
    retryKey = null;
    manualRecipient = '';
    refs.phoneStatus.textContent = '';
    refs.phoneChat.hidden = true;
    refs.phoneChat.removeAttribute('href');
    refs.phoneDraft.hidden = true;
    refs.phoneSubmit.disabled = false;
  }
  function setBusy(busy) {
    refs.phoneNumber.readOnly = busy;
    refs.phoneBrief.readOnly = busy;
    refs.phoneSubmit.disabled = busy;
  }
  refs.openPhoneDispatch.addEventListener('click', () => {
    generation++;
    refs.phoneForm.reset();
    setBusy(false);
    resetResult();
    refs.phoneDialog.showModal();
  }, options);
  refs.phoneDialog.addEventListener('close', () => {
    if (refs.phoneDialog.open) return;
    generation++;
    refs.phoneForm.reset();
    resetResult();
  }, options);
  refs.phoneForm.addEventListener('input', resetResult, options);
  refs.phoneForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (refs.phoneSubmit.disabled || ctx.getState().pending !== null) return;
    const requestGeneration = generation;
    const number = refs.phoneNumber.value.trim();
    const briefing = refs.phoneBrief.value.trim() || undefined;
    retryKey ??= crypto.randomUUID();
    setBusy(true);
    refs.phoneStatus.textContent = 'Checking for a verified Telegram conversation…';
    ctx.setState({ pending: 'dispatch_phone' });
    try {
      const result = await ctx.api.dispatchByPhone(number, briefing, retryKey);
      if (signal.aborted || generation !== requestGeneration || !refs.phoneDialog.open) return;
      if (result.outcome === 'dispatched') {
        const item = result.dispatch.results.find(row => row.chatId === result.chatId);
        if (!item) throw new Error('The dispatch response was incomplete.');
        refs.phoneStatus.textContent = receipt(item.status);
        refs.phoneChat.href = chatHref(result.chatId);
        refs.phoneChat.hidden = false;
        ctx.refreshers.inbox.request();
        if (ctx.getState().selectedChatId === result.chatId) ctx.refreshers.timeline.request();
      } else if (result.outcome === 'ambiguous') {
        refs.phoneStatus.textContent = 'Multiple verified conversations match this number. Check the contact in the inbox, then use Dispatch this chat in the correct conversation.';
      } else if (result.outcome === 'no_verified_chat') {
        manualRecipient = telegramRecipient(number);
        refs.phoneStatus.textContent = 'No verified Telegram conversation matches this number. You can prepare a first message to send yourself.';
        refs.phoneDraft.hidden = false;
      } else {
        throw new Error('The dispatch response was incomplete.');
      }
      setBusy(false);
      refs.phoneSubmit.disabled = true;
    } catch (error) {
      if (signal.aborted || generation !== requestGeneration || !refs.phoneDialog.open) return;
      refs.phoneStatus.textContent = error?.code === 'validation_failed'
        ? 'Enter a complete international number with its country code and check the briefing length.'
        : describeError(error);
      setBusy(false);
    } finally {
      if (!signal.aborted) ctx.setState({ pending: null });
    }
  }, options);
  refs.phoneChat.addEventListener('click', () => refs.phoneDialog.close(), options);
  refs.phoneDraft.addEventListener('click', () => {
    const briefing = refs.phoneBrief.value;
    const recipient = manualRecipient;
    refs.phoneDialog.close();
    openOpener(briefing, recipient);
  }, options);
  refs.openTelegramDraft.addEventListener('click', () => {
    const recipient = refs.openerRecipientNumber.textContent;
    const draft = refs.openerDraft.value.trim();
    if (!refs.openerDialog.open || !/^\+[1-9]\d{1,14}$/.test(recipient) || !draft) return;
    const url = new URL('https://t.me/' + recipient);
    url.searchParams.set('text', draft);
    window.open(url.href, '_blank', 'noopener,noreferrer');
  }, options);
}
