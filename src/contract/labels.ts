/** Exact user-facing strings fixed by the brief. Use these constants; never retype the text. */
export const LABELS = {
  newInbound: 'New inbound',
  dispatch: 'Dispatch',
  contactStartedChat: 'Contact started chat',
  officerStartedChat: 'Officer started chat',
  firstObservedIncoming: 'First observed: incoming',
  firstObservedOutgoing: 'First observed: outgoing',
  noMessagesObserved: 'No messages observed',
  suspectedFraud: 'Suspected fraud',
  pauseAi: 'Pause AI',
  takeOver: 'Take over',
  resumeAi: 'Resume AI',
  send: 'Send',
  leaveUnanswered: 'Leave unanswered',
  acknowledgementTemplate: 'Message received.',
  simulatedSend: 'Simulated send',
  mirsadRenderedCapture: 'Mirsad-rendered capture',
  phoneWatchlist: 'Phone watchlist',
  needsReview: 'Needs review',
  approved: 'Approved',
  cleared: 'Cleared',
  watchlistMatch: 'Watchlist match',
  noNewFinding: 'No new finding',
  readyForControlledTest: 'Ready for controlled test',
  controlledTestVerified: 'Controlled test verified',
  newPaymentLink: 'New payment link',
  newPaymentRecipient: 'New payment recipient',
  paymentDestinationChanged: 'Payment destination changed',
  phoneNumberTiedToConcern: 'Phone number tied to a concern',
} as const;

export const CHANNEL_LABELS = { telegram: 'Telegram', citizen_report: 'Citizen report' } as const;

export const ORIGIN_LABELS = [
  LABELS.contactStartedChat,
  LABELS.officerStartedChat,
  LABELS.firstObservedIncoming,
  LABELS.firstObservedOutgoing,
  LABELS.noMessagesObserved,
] as const;
export type OriginLabel = (typeof ORIGIN_LABELS)[number];

export const FINDING_LABELS = [
  LABELS.newPaymentLink,
  LABELS.newPaymentRecipient,
  LABELS.paymentDestinationChanged,
  LABELS.phoneNumberTiedToConcern,
  LABELS.suspectedFraud,
] as const;
export type FindingLabel = (typeof FINDING_LABELS)[number];

export const WATCHLIST_STATUS_LABELS = {
  needs_review: LABELS.needsReview,
  approved: LABELS.approved,
  cleared: LABELS.cleared,
} as const;

/** Where a flagged number stands with the contact-sync server (WatchlistEntry.contactSync), by state or by why it was not sent. */
export const CONTACT_SYNC_LABELS = {
  on_phones: 'On phones',
  queued: 'Queued',
  no_international_number: 'Not sent: no international number',
  unreachable: 'Not sent: server unreachable',
  timeout: 'Not sent: server timed out',
  server_error: 'Not sent: server error',
  token_refused: 'Not sent: token refused',
  number_refused: 'Not sent: number refused',
} as const;

/** The Places map's names for a flagged listing website (WebsiteFlag); the dashboard legend and filter use these. */
export const WEBSITE_FLAG_LABELS = {
  harmful: 'Harmful website',
  suspicious: 'Redirects elsewhere',
  parked: 'Expired or parked',
  unconfirmed: 'Low-confidence warning',
} as const;
