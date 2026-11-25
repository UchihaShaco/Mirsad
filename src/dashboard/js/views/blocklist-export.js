/** Export blocklist: downloads the signed phone blocklist as a file the officer can pass to phones. */
import { describeError, formatTime } from '../format.js';

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export function bindBlocklistExport(ctx) {
  const { refs } = ctx;
  const { signal } = ctx.listeners;
  refs.exportBlocklist.addEventListener('click', async () => {
    if (ctx.getState().pending !== null) return;
    refs.exportBlocklist.disabled = true;
    refs.blocklistStatus.className = '';
    refs.blocklistStatus.textContent = 'Signing the blocklist…';
    try {
      const file = await ctx.api.exportBlocklist();
      if (signal.aborted) return;
      const blob = new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `mirsad-blocklist-${file.issuedAt.slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const contents = `${plural(file.numbers.length, 'number', 'numbers')} and ${plural(file.fingerprints.length, 'message fingerprint', 'message fingerprints')}`;
      refs.blocklistStatus.textContent = file.numbers.length + file.fingerprints.length === 0
        ? `Exported an empty list (key ${file.keyId}). Importing it clears the previous list on a phone.`
        : `Exported ${contents}, signed with key ${file.keyId}, valid until ${formatTime(file.expiresAt)}.`;
    } catch (error) {
      if (signal.aborted) return;
      refs.blocklistStatus.className = 'error';
      refs.blocklistStatus.textContent = describeError(error);
    } finally {
      if (!signal.aborted) refs.exportBlocklist.disabled = false;
    }
  }, { signal });
}
