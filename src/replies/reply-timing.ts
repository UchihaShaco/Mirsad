/** Minimum quiet period before submitting a reply or recognizing a new exchange after a contact stop. */
export const REPLY_QUIET_MS = 3_000;
/** The reply worker and intake both exclude delayed Telegram backlog beyond this window. */
export const REPLY_FRESHNESS_MS = 15 * 60 * 1000;
