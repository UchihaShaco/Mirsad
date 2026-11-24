import { describeError } from '../format.js';
import { chatHref } from '../state/route.js';

function telegramReceipt(result) {
  const counts = [
    `Telegram confirmed ${result.removed} of ${result.total} known messages removed.`,
    `${result.skipped} skipped, ${result.failed} failed, ${result.uncertain} unconfirmed, ${result.pending} pending.`,
  ];
  const excluded = [
    ['expired', 'outside the deletion window'], ['rights', 'without deletion permission'],
    ['unverified', 'without a verified Telegram address'], ['unsupported', 'unsupported'],
  ].filter(([reason]) => result.excluded[reason] > 0);
  if (excluded.length) counts.push('Skipped messages include ' + excluded.map(([key, label]) => `${result.excluded[key]} ${label}`).join(', ') + '.');
  if (result.status === 'in_progress') counts.push('Check Telegram status for the final result.');
  else counts.push('Telegram may have older messages Mirsad never saw. Open the chat in Telegram and use Clear History for both people if available.');
  return counts;
}

/** A preview fixes the scope each officer confirms. Telegram and local erasure are separately authorized operations. */
export function bindErase(ctx, clearErased) {
  const { refs } = ctx;
  const options = { signal: ctx.listeners.signal };
  let active = null;
  const operations = new Map();
  const current = op => active === op && refs.eraseDialog.open && !options.signal.aborted;
  const hasConfirmation = op => op.id !== null || refs.eraseTyped.value === 'ERASE';

  function controls(op) {
    const enabled = !op.busy && op.preview?.chatCount > 0 && hasConfirmation(op);
    refs.eraseConfirm.disabled = !enabled || (op.remote && op.remote.result?.status !== 'completed');
    const check = op.remote && op.remote.result?.status !== 'completed';
    refs.eraseTelegram.textContent = check ? 'Check Telegram status' : 'Delete from Telegram for both';
    refs.eraseTelegram.disabled = op.busy || (!check && (!enabled || Boolean(op.remote)));
    refs.eraseCancel.disabled = op.localSubmitting === true;
    refs.eraseTyped.readOnly = op.busy;
    refs.eraseCancel.textContent = op.remote ? 'Close' : 'Cancel';
  }

  function drawReceipt(result) {
    refs.eraseTelegramResult.replaceChildren();
    refs.eraseTelegramResult.hidden = !result;
    if (!result) return;
    for (const line of telegramReceipt(result)) {
      const p = document.createElement('p');
      p.textContent = line;
      refs.eraseTelegramResult.append(p);
    }
    if (result.remainingChats.length === 0) return;
    const title = document.createElement('strong');
    title.textContent = 'Conversations with messages to check';
    const list = document.createElement('ul');
    const labels = new Map(ctx.getState().chats.map(chat => [chat.id, chat.displayLabel]));
    for (const row of result.remainingChats) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = chatHref(row.chatId);
      link.textContent = labels.get(row.chatId) ?? 'Conversation';
      link.dir = 'auto';
      link.addEventListener('click', () => {
        refs.eraseDialog.close();
        if (refs.settingsDialog.open) refs.settingsDialog.close();
      });
      li.append(link, document.createTextNode(` · ${row.skipped} skipped, ${row.failed} failed, ${row.uncertain} unconfirmed, ${row.pending} pending`));
      list.append(li);
    }
    refs.eraseTelegramResult.append(title, list);
  }

  async function preview(op, afterRemote = false) {
    op.busy = true;
    controls(op);
    refs.eraseStatus.textContent = 'Checking the current inbox history…';
    try {
      const data = await ctx.api.previewErase(op.id);
      if (!current(op)) return;
      if (afterRemote) {
        if (op.preview?.snapshot !== data.snapshot) refs.eraseTyped.value = '';
        op.remote.completedSnapshot = data.snapshot;
      } else if (op.remote?.completedSnapshot && op.remote.completedSnapshot !== data.snapshot) {
        operations.delete(op.id);
        op.remote = null;
        drawReceipt(null);
      }
      op.preview = data;
      op.localKey = crypto.randomUUID();
      refs.eraseConfirm.textContent = op.id === null ? `Erase all ${data.chatCount} chats` : 'Erase this chat';
      refs.eraseStatus.textContent = data.chatCount === 0 ? 'There are no local conversations to erase.'
        : op.id === null ? `${data.chatCount} local ${data.chatCount === 1 ? 'conversation' : 'conversations'} in your inbox.`
        : 'One local conversation selected.';
    } catch (error) {
      if (!current(op)) return;
      op.preview = null;
      refs.eraseStatus.textContent = describeError(error) + ' Close and reopen this confirmation to refresh.';
    } finally {
      if (current(op)) { op.busy = false; controls(op); }
    }
  }

  function open(id, label = '') {
    const op = { id, preview: null, busy: false, localKey: null, remote: operations.get(id) ?? null };
    active = op;
    refs.eraseDialog.returnValue = '';
    refs.eraseForm.reset();
    refs.eraseHeading.textContent = id === null ? 'Erase entire inbox' : 'Reset this chat';
    refs.eraseDescription.textContent = id === null
      ? 'Choose which history to erase for every conversation you can access.'
      : 'Choose which history to erase for this conversation.';
    refs.eraseChatLine.hidden = id === null;
    refs.eraseChatLabel.textContent = label;
    refs.eraseTypedField.hidden = id !== null;
    refs.eraseConfirm.textContent = id === null ? 'Erase local inbox' : 'Erase this chat';
    drawReceipt(op.remote?.result);
    refs.eraseDialog.showModal();
    refs.eraseCancel.focus();
    void preview(op);
  }

  async function eraseTelegram(op) {
    if (op.busy || refs.eraseTelegram.disabled || !op.preview) return;
    op.busy = true;
    op.remote ??= { key: crypto.randomUUID(), snapshot: op.preview.snapshot, result: null };
    operations.set(op.id, op.remote);
    controls(op);
    refs.eraseStatus.textContent = 'Checking Telegram deletion…';
    try {
      const result = await ctx.api.eraseTelegram(op.id, op.remote.snapshot, op.remote.key);
      op.remote.result = result;
      if (!current(op)) return;
      drawReceipt(result);
      if (result.status === 'completed') await preview(op, true);
      else refs.eraseStatus.textContent = 'Telegram deletion is in progress.';
    } catch (error) {
      if (!current(op)) return;
      if (error.code === 'revision_conflict') {
        operations.delete(op.id);
        op.preview = null;
        op.remote = null;
        refs.eraseStatus.textContent = 'The conversation history changed. Close and reopen this confirmation to review it again.';
      } else {
        refs.eraseStatus.textContent = describeError(error) + ' Use Check Telegram status to check this same request.';
      }
    } finally {
      if (current(op)) { op.busy = false; controls(op); }
    }
  }

  async function eraseLocal(op) {
    if (op.busy || refs.eraseConfirm.disabled) return;
    op.busy = true;
    op.localSubmitting = true;
    controls(op);
    refs.eraseStatus.textContent = 'Erasing local history…';
    try {
      const result = await ctx.api.erase(op.id, op.preview.snapshot, op.localKey);
      if (!current(op)) return;
      const local = `${result.chatCount} local ${result.chatCount === 1 ? 'conversation' : 'conversations'} erased.`;
      const files = result.filesPending ? ` ${result.filesPending} capture files pending removal.` : '';
      const remote = op.remote?.result ? ' ' + telegramReceipt(op.remote.result).join(' ') : '';
      operations.delete(op.id);
      if (op.id === null) operations.clear();
      refs.eraseDialog.close();
      if (refs.settingsDialog.open) refs.settingsDialog.close();
      clearErased(op.id, local + files + remote);
    } catch (error) {
      if (!current(op)) return;
      if (error.code === 'revision_conflict') {
        op.preview = null;
        refs.eraseStatus.textContent = 'The conversation history changed. Close and reopen this confirmation to review it again.';
      } else refs.eraseStatus.textContent = describeError(error);
    } finally {
      op.localSubmitting = false;
      if (current(op)) { op.busy = false; controls(op); }
    }
  }

  refs.resetThisChat.addEventListener('click', () => {
    const chat = ctx.getState().timeline?.chat;
    if (chat && ctx.getState().selectedChatId === chat.id) open(chat.id, chat.displayLabel);
  }, options);
  refs.eraseInbox.addEventListener('click', () => open(null), options);
  refs.eraseTyped.addEventListener('input', () => { if (active) controls(active); }, options);
  refs.eraseTelegram.addEventListener('click', () => { if (active) void eraseTelegram(active); }, options);
  refs.eraseConfirm.addEventListener('click', () => { if (active) void eraseLocal(active); }, options);
  refs.eraseForm.addEventListener('submit', event => event.preventDefault(), options);
  refs.eraseCancel.addEventListener('click', () => refs.eraseDialog.close(), options);
  refs.eraseDialog.addEventListener('cancel', event => { if (active?.localSubmitting) event.preventDefault(); }, options);
  refs.eraseDialog.addEventListener('close', () => {
    if (refs.eraseDialog.open) return;
    active = null;
    refs.eraseTyped.value = '';
    refs.eraseChatLabel.textContent = '';
    drawReceipt(null);
  }, options);
  return id => {
    if (id === null) operations.clear();
    else operations.delete(id);
    if (!active || active.localSubmitting || !refs.eraseDialog.open) return;
    if (id === null || active.id === id) refs.eraseDialog.close();
  };
}
