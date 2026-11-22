/**
 * The Record merchant confirmation form (pure; types in case-reference.d.ts). It only shapes the request for
 * POST /v1/chats/{chatId}/case-references: the service normalizes and validates the hosts and decides which payment
 * links conflict with the confirmation.
 */

const HOSTS_MAX = 20;
const NOTE_MIN = 3;
const NOTE_MAX = 500;

export function initialCaseReferenceDraft() {
  return { hosts: '', note: '' };
}

/** Hosts separated by commas or line breaks, trimmed, without blanks or repeats, in the order written. */
export function parsePaymentHosts(text) {
  return [...new Set(text.split(/[,\r\n]+/).map((host) => host.trim()).filter((host) => host !== ''))];
}

/** The request for a complete draft (1 to 20 hosts, a source note of 3 to 500 characters), otherwise null. */
export function caseReferenceRequest(draft) {
  const paymentHosts = parsePaymentHosts(draft.hosts);
  const sourceNote = draft.note.trim();
  const hostsOk = paymentHosts.length > 0 && paymentHosts.length <= HOSTS_MAX;
  const noteOk = sourceNote.length >= NOTE_MIN && sourceNote.length <= NOTE_MAX;
  return hostsOk && noteOk ? { kind: 'merchant_payment_confirmation', paymentHosts, sourceNote } : null;
}
