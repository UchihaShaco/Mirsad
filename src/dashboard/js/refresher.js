/**
 * Coalesces reloads triggered by stream events: `load` runs at most once at a time, and requests made while it runs, or
 * within `delayMs` of the first, fold into a single further run. Errors go to `onError`. Types in refresher.d.ts.
 */

/**
 * Stream events arrive in bursts (one commit can publish several); reloads requested within this window coalesce. A
 * resource then reloads at most once per window plus its load time, about 60 times a minute under a sustained stream,
 * so the three refreshers together stay well under the service's 600 requests a minute per token.
 */
export const REFRESH_DELAY_MS = 1000;

export function createRefresher(load, delayMs, onError) {
  let timer = null;
  let running = false;
  let again = false;

  async function run() {
    timer = null;
    running = true;
    again = false;
    try {
      await load();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (again) request();
    }
  }

  function request() {
    if (running) {
      again = true;
      return;
    }
    if (timer === null) timer = setTimeout(run, delayMs);
  }

  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    again = false;
  }

  return { request, cancel };
}
