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

export const CHANNEL_LABELS = { telegram: 'Telegram' } as const;

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
