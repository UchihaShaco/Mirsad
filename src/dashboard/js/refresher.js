/**
 * Coalesces reloads triggered by stream events: `load` runs at most once at a time, and requests made while it runs, or
 * within `delayMs` of the first, fold into a single further run. Errors go to `onError`.
 */
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
