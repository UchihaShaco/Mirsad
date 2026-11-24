/** Types for attention.js (the browser loads the JavaScript; tests and typecheck read this declaration). */
import type { ChatSummary, Timeline } from '../../../contract/schemas.ts';

type ReplyHold = ChatSummary['telegramReplyHold'];
type ReviewReason = ReplyHold['evidenceItems'][number]['reason'];

/** One item for officer review; a legacy hold carries no source event. */
export interface ReviewItem {
  actionId: string;
  messageId: string;
  messageEventId?: string | null;
  reason: ReviewReason;
}

export interface ReviewQueue {
  items: readonly ReviewItem[];
  /** True while the service holds automated replies for these reviews. */
  blocking: boolean;
}

export type ControlState =
  | 'not_started'
  | 'ai_active'
  | 'ai_waiting'
  | 'ai_held'
  | 'ai_opted_out'
  | 'paused'
  | 'officer_self'
  | 'officer_other';

export interface EvidenceSource {
  actionId: string;
  reason: ReviewReason;
  blocking: boolean;
}

export function reviewQueue(hold: Pick<ReplyHold, 'officerReview'> & { evidenceItems?: ReplyHold['evidenceItems'] }): ReviewQueue;
export function itemHoldsReplies(item: Pick<ReviewItem, 'reason'>, hold: Pick<ReplyHold, 'officerReview'>): boolean;
export function controlState(
  chat: Pick<ChatSummary, 'aiMode' | 'controller' | 'telegramReplyHold'>,
  me: { id: string } | null | undefined,
  permission?: Timeline['telegramAiPermission'],
): ControlState;
export function isLiveChat(timeline: Pick<Timeline, 'messages'>): boolean;
export function evidenceSources(timeline: Pick<Timeline, 'chat' | 'messageEvents'>): Map<string, EvidenceSource[]>;
