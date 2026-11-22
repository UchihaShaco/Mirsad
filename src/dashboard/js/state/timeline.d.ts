/** Types for timeline.js (the browser loads the JavaScript; tests and typecheck read this declaration). */
import type { CaseAction, Finding, Message, MessageEvent, Timeline } from '../../../contract/schemas.ts';

export type TimelineEntry =
  | { kind: 'message'; id: string; position: number; item: Message }
  | { kind: 'message_event'; id: string; position: number; item: MessageEvent }
  | { kind: 'finding'; id: string; position: number; item: Finding }
  | { kind: 'case_action'; id: string; position: number; item: CaseAction };

export function timelineEntries(
  timeline: Pick<Timeline, 'messages' | 'messageEvents' | 'caseActions' | 'findings'>,
): TimelineEntry[];
export function latestIncomingMessageId(timeline: Pick<Timeline, 'messages'>): string | null;
