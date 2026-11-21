import type { Concern, ExtractedKind, Source } from '../contract/enums.ts';

/**
 * One reviewed message event (design section 10). `messageId` is the internal `msg_…` ID the reviewer must
 * echo as `sourceMessageId`; `text` is the reviewed event's own text (original, edited or conflicting copy).
 */
export interface ReviewRequest {
  reviewId: string;
  chatId: string;
  messageId: string;
  messageEventId: string;
  source: Source;
  text: string;
}

/** An item the reviewer claims the message contains. Code validates it before anything is shown. */
export interface ExtractedItem {
  sourceMessageId: string;
  kind: ExtractedKind;
  quote: string;
  extractedValue: string;
  concern: Concern | null;
  /** ISO 3166 alpha-2 country hint, or null when unknown. */
  countryHint: string | null;
}

/** A validated phone item with a concern, handed to the watchlist (repeats included; design section 10). */
export interface PhoneMention {
  e164: string | null;
  digits: string;
  sourceRepresentation: string;
  concern: Concern;
  findingId: string | null;
}

export interface ReviewerHealth {
  reachable: boolean;
  modelId: string | null;
}

export interface Reviewer {
  readonly name: string;
  review(request: ReviewRequest, signal: AbortSignal): Promise<{ items: ExtractedItem[] }>;
  health?(): Promise<ReviewerHealth>;
}

/** Thrown by a reviewer that cannot answer; `code` is stored on the review and logged. */
export class ReviewerUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'ReviewerUnavailableError';
    this.code = code;
  }
}
