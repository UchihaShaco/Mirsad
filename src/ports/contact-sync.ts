/**
 * The contact-sync server (mirsad-contact-sync/): phones connected to it keep every active number in a contact named
 * "Known Scammer". Mirsad sends it a number, a fixed label and source, and the watchlist entry ID; never a name or text.
 */
export const CONTACT_SYNC_ERROR_CODES = ['unreachable', 'timeout', 'server_error', 'token_refused', 'number_refused'] as const;
export type ContactSyncErrorCode = (typeof CONTACT_SYNC_ERROR_CODES)[number];

/** Delivered, or not with a code; `retry` is false when sending the same request again cannot succeed. */
export type ContactSyncOutcome = { ok: true } | { ok: false; code: ContactSyncErrorCode; retry: boolean };

export interface ContactSyncPublisher {
  /** Adds the number as active, or makes it active again (an upsert keyed by the number). */
  publish(e164: string, reference: string): Promise<ContactSyncOutcome>;
  /** Makes the number inactive and keeps its history on the server; a number the server never had needs nothing. */
  withdraw(e164: string): Promise<ContactSyncOutcome>;
}
