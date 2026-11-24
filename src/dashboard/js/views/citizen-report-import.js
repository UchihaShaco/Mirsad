/**
 * Import report: the officer picks the JSON file a citizen shared from Mirsad Android. The file is read in the browser
 * and sent once to the portal; it is never shown in the URL or kept in the page.
 */
import { describeError } from '../format.js';
import { chatHref } from '../state/route.js';

const MAX_REPORT_BYTES = 256 * 1024;

export function bindCitizenReportImport(ctx) {
  const { refs } = ctx;
  const { signal } = ctx.listeners;
  const options = { signal };
  let generation = 0;

  function reset() {
    refs.reportStatus.textContent = '';
    refs.reportStatus.className = '';
    refs.reportOpen.hidden = true;
    refs.reportOpen.removeAttribute('href');
    refs.reportSubmit.disabled = false;
  }
  function say(text, tone) {
    refs.reportStatus.textContent = text;
    refs.reportStatus.className = tone === 'error' ? 'error' : '';
  }
  refs.openReportImport.addEventListener('click', () => {
    generation++;
    refs.reportForm.reset();
    reset();
    refs.reportDialog.showModal();
  }, options);
  refs.reportDialog.addEventListener('close', () => {
    if (refs.reportDialog.open) return;
    generation++;
    refs.reportForm.reset();
    reset();
  }, options);
  refs.reportForm.addEventListener('input', reset, options);
  refs.reportOpen.addEventListener('click', () => refs.reportDialog.close(), options);
  refs.reportForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = refs.reportFile.files?.[0];
    if (!file || refs.reportSubmit.disabled || ctx.getState().pending !== null) return;
    if (file.size > MAX_REPORT_BYTES) return say('This file is too large to be a Mirsad Android report.', 'error');
    let report;
    try {
      report = JSON.parse(await file.text());
    } catch {
      return say('This file is not JSON. Choose the report file the citizen shared.', 'error');
    }
    const requestGeneration = generation;
    refs.reportSubmit.disabled = true;
    say('Importing…');
    ctx.setState({ pending: 'import_report' });
    try {
      const result = await ctx.api.importCitizenReport(report, refs.reportDemo.checked);
      if (signal.aborted || generation !== requestGeneration) return;
      let text = 'This report was imported before. It is unchanged.';
      if (result.created && result.demo) text = 'Imported as a Demo report. Nothing was added to the phone watchlist.';
      else if (result.created) {
        text = result.watchlistNumbers === 0 ? 'Imported. The report named no new number for the phone watchlist.'
          : `Imported. ${result.watchlistNumbers === 1 ? '1 number was' : `${result.watchlistNumbers} numbers were`} sent to the phone watchlist for review.`;
      }
      say(text);
      refs.reportOpen.href = chatHref(result.chatId, result.messageId);
      refs.reportOpen.hidden = false;
      ctx.refreshers.inbox.request();
      if (ctx.getState().view === 'watchlist') ctx.refreshers.watchlist.request();
    } catch (error) {
      if (signal.aborted || generation !== requestGeneration) return;
      say(describeError(error), 'error');
      refs.reportSubmit.disabled = false;
    } finally {
      if (!signal.aborted) ctx.setState({ pending: null });
    }
  }, options);
}
