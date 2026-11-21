/** Event stream types (design section 12). Data carries ids and statuses only, never message text. */
import type {
  AiMode,
  CaptureStatus,
  CaseActionType,
  Direction,
  FindingKind,
  InboxStatus,
  MessageOrigin,
  ReviewOutcome,
  ReviewStatus,
  WatchlistStatus,
} from './enums.ts';

export interface StreamEventDataMap {
  'chat.created': { inboxStatus: InboxStatus };
  'chat.control_changed': { aiMode: AiMode; revision: number };
  'message.recorded': { messageId: string; direction: Direction | null; origin: MessageOrigin };
  'message.edited': { messageId: string; messageEventId: string };
  'message.deleted': { messageId: string; messageEventId: string };
  'capture.updated': {
    messageId: string;
    messageEventId: string;
    captureId: string;
    status: CaptureStatus;
    artifactId: string | null;
  };
  'review.updated': { messageId: string; messageEventId: string; status: ReviewStatus; outcome: ReviewOutcome | null };
  'finding.created': { messageId: string; findingId: string; kind: FindingKind };
  'case_action.recorded': { caseActionId: string; actionType: CaseActionType };
  'case_reference.recorded': { caseReferenceId: string };
  'watchlist.entry_updated': {
    watchlistEntryId: string;
    status: WatchlistStatus;
    reason: 'created' | 'observation_added' | 'reviewed';
  };
  'watchlist.match': { watchlistEntryId: string };
  'stream.reset': { reason: 'cursor_out_of_retention'; resumeFrom: string; reload: ('inbox' | 'timeline')[] };
}

export type StreamEventType = keyof StreamEventDataMap;

export const STREAM_EVENT_TYPES = [
  'chat.created',
  'chat.control_changed',
  'message.recorded',
  'message.edited',
  'message.deleted',
  'capture.updated',
  'review.updated',
  'finding.created',
  'case_action.recorded',
  'case_reference.recorded',
  'watchlist.entry_updated',
  'watchlist.match',
  'stream.reset',
] as const satisfies readonly StreamEventType[];

/** Types written to the stream_events table (stream.reset is synthesized by the reader). */
export type StoredStreamEventType = Exclude<StreamEventType, 'stream.reset'>;

/** The JSON carried in an SSE frame's `data:` line. */
export type StreamWireMessage<T extends StreamEventType = StreamEventType> = {
  id: string;
  type: T;
  chatId: string | null;
  occurredAt: string;
} & StreamEventDataMap[T];
