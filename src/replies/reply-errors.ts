export const REPLY_FAILURE_CODES = [
  'lmstudio_unreachable',
  'lmstudio_timeout',
  'lmstudio_redirect_refused',
  'lmstudio_http_error',
  'gemini_unreachable',
  'gemini_key_missing',
  'gemini_timeout',
  'gemini_auth_error',
  'gemini_insufficient_credits',
  'gemini_rate_limited',
  'gemini_http_error',
  'gemini_blocked',
  'gemini_incomplete',
  'invalid_response',
  'empty_reply',
  'reply_aborted',
] as const;
export type ReplyFailureCode = (typeof REPLY_FAILURE_CODES)[number];

/** A reply could not be written; `code` is stored and logged, never text. */
export class ReplyGenerationError extends Error {
  readonly code: ReplyFailureCode;

  constructor(code: ReplyFailureCode) {
    super(`reply generation failed: ${code}`);
    this.name = 'ReplyGenerationError';
    this.code = code;
  }
}
