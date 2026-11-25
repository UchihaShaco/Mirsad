/** Types for the pure parts of places-map.js that tests import; the view itself is driven through the DOM. */
export const WEBSITE_FLAG_LABELS: Record<'harmful' | 'suspicious' | 'parked' | 'unconfirmed', string>;
export const WEBSITE_FINDING_TEXT: Record<string, string>;
export function defangUrl(url: string): string;
export function createPlacesView(refs: unknown, api: unknown, signal: AbortSignal): {
  refresh(): void;
  search(q: string): void;
  destroy(): void;
};
