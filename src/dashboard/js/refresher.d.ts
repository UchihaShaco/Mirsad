/** Types for refresher.js (the browser loads the JavaScript; tests and typecheck read this declaration). */

/** The window in which stream-triggered reloads of one resource coalesce. */
export const REFRESH_DELAY_MS: number;

export interface Refresher {
  request(): void;
  cancel(): void;
}

export function createRefresher(load: () => Promise<unknown>, delayMs: number, onError: (error: unknown) => void): Refresher;
