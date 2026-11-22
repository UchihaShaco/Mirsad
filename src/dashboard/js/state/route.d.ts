/** Types for route.js (the browser loads the JavaScript; tests and typecheck read this declaration). */

export interface Route {
  view: 'inbox' | 'watchlist';
  chatId: string | null;
  messageId: string | null;
}

/** The token of a one-time #token= sign-in fragment, decoded and trimmed, or null. */
export function tokenFromFragment(hash: string): string | null;
export function parseRoute(hash: string): Route;
export function chatHref(chatId: string, messageId?: string | null): string;
