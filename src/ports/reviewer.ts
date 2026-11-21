import type { Concern, ExtractedKind } from '../contract/enums.ts';

/** One message handed to a reviewer: its ID and text, nothing else (design section 10). */
export interface ReviewRequest {
  messageId: string;
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
