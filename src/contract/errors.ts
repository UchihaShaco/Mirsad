/** Error codes, the response envelope and the application error type (design section 5). */

export const ERROR_STATUS = {
  validation_failed: 400,
  idempotency_key_required: 400,
  unauthenticated: 401,
  forbidden_for_principal: 403,
  account_not_authorized: 403,
  not_controller: 403,
  evidence_access_required: 403,
  host_not_allowed: 403,
  origin_not_allowed: 403,
  chat_not_found: 404,
  account_not_found: 404,
  message_not_found: 404,
  artifact_not_found: 404,
  capture_not_found: 404,
  watchlist_entry_not_found: 404,
  not_found: 404,
  revision_conflict: 409,
  invalid_transition: 409,
  not_in_takeover: 409,
  capture_not_retryable: 409,
  history_erased: 410,
  payload_too_large: 413,
  idempotency_key_reused: 422,
  direction_required: 422,
  reply_prompt_unavailable: 422,
  rate_limited: 429,
  internal_error: 500,
  artifact_integrity_error: 500,
  not_implemented: 501,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type ErrorDetails = Record<string, unknown>;

export interface ErrorBody {
  code: string;
  message: string;
  details?: ErrorDetails;
}

export interface ListMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  error: null;
  meta?: ListMeta;
}

export interface FailureEnvelope {
  success: false;
  data: null;
  error: ErrorBody;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetails | undefined;

  constructor(status: number, code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Builds an AppError whose status comes from the fixed code table. */
  static of(code: ErrorCode, message: string, details?: ErrorDetails): AppError {
    return new AppError(ERROR_STATUS[code], code, message, details);
  }
}

export function ok<T>(data: T, meta?: ListMeta): SuccessEnvelope<T> {
  return meta ? { success: true, data, error: null, meta } : { success: true, data, error: null };
}

export function fail(error: ErrorBody): FailureEnvelope {
  const body: ErrorBody = { code: error.code, message: error.message };
  if (error.details !== undefined) body.details = error.details;
  return { success: false, data: null, error: body };
}
