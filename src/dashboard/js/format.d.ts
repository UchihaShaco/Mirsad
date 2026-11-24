/** Types for format.js (the browser loads the JavaScript; tests and typecheck read this declaration). */
import type { DispatchResponse, Message, TelegramDispatchOutcome, TelegramReplies, Timeline } from '../../contract/schemas.ts';

export const AI_MODE_LABELS: Readonly<Record<string, string>>;
export const DIRECTION_LABELS: Readonly<Record<string, string>>;
export const TELEGRAM_EVIDENCE_LABELS: Readonly<Record<string, string>>;
export function reviewWarningLabel(reason: string): string | null;
export function conversationReviewSummary(detail?: Record<string, unknown>): string;
export function silenceSummary(detail?: Record<string, unknown> | null): string;
/** The model's stored explanation of a silence, or null when it gave none. */
export function silenceExplanation(detail?: Record<string, unknown> | null): string | null;
export function evidenceItemsFor<T>(hold: { officerReview: T | null; evidenceItems?: readonly T[] }): readonly T[];
export function evidenceCountLabel(count: number): string;
export const CAPTURE_METHOD_LABELS: Readonly<Record<string, string>>;
export const CASE_ACTION_LABELS: Readonly<Record<string, string>>;
/** Why an AI reply failed, for the failure codes whose plain code would mislead (keyed by code). */
export const AI_REPLY_FAILURE_NOTES: Readonly<Record<string, string>>;
export const OBSERVATION_ORIGIN_LABELS: Readonly<Record<string, string>>;
export const REPORT_REASON_LABELS: Readonly<Record<string, string>>;
export const PHONE_VERDICT_LABELS: Readonly<Record<'HOLD' | 'WARN' | 'ALLOW', string>>;
export const REPORT_CHANNEL_LABELS: Readonly<Record<'SMS' | 'CALL' | 'CHAT', string>>;

export function reviewStatusLabel(review: Pick<NonNullable<Message['review']>, 'status' | 'outcome'>): string;
/** 2026-11-21T08:00:00.000Z -> 2026-11-21 08:00:00 UTC; anything else gives an empty string. */
export function formatTime(iso: unknown): string;
/** 2026-11-21T08:05:00.000Z -> 21 Nov, 08:05 UTC; anything else gives an empty string. */
export function formatCompactTime(iso: unknown): string;
/** 2026-11-21T08:05:00.000Z -> 08:05 UTC; anything else gives an empty string. */
export function formatClock(iso: unknown): string;
/** 2026-11-21T08:05:00.000Z -> Sat 21 November 2026; anything else gives an empty string. */
export function formatDay(iso: unknown): string;
export function describeError(error: unknown): string;
export function describeCaseReference(findingsCreated: number): string;
export function describeDispatch(results: readonly Pick<DispatchResponse['results'][number], 'status'>[]): string;
export function dispatchReason(reason: string | null): string;
export function telegramDispatchReceipt(outcome: TelegramDispatchOutcome): string;
export function telegramRequestReceipt(request: NonNullable<TelegramReplies['request']>, actions: Timeline['caseActions']): string;
