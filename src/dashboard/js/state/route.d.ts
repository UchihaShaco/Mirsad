/** Types for route.js (the browser loads the JavaScript; tests and typecheck read this declaration). */

export interface Route {
  view: 'inbox' | 'watchlist' | 'places';
  chatId: string | null;
  messageId: string | null;
  eventId?: string;
  previous?: boolean;
  /** A phone number or website to look up when the Places map opens. */
  placesQuery?: string;
}

/** The token of a one-time #token= sign-in fragment, decoded and trimmed, or null. */
export function tokenFromFragment(hash: string): string | null;
export function parseRoute(hash: string): Route;
export function placesHref(query: string): string;
export function chatHref(chatId: string, messageId?: string | null, eventId?: string | null): string;
