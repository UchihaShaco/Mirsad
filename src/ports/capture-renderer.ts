import type { CaptureMethod, Direction, Source } from '../contract/enums.ts';

/** Everything a capture image shows (design section 9). The renderer is a pure function of this input. */
export interface CaptureRenderInput {
  captureKind: 'mirsad_rendered_capture';
  channel: Source;
  captureMethod: CaptureMethod;
  chatLabel: string;
  chatId: string;
  messageId: string;
  messageEventId: string;
  /** Every source message event with content has a capture, conflicting copies included (design section 9). */
  eventType: 'recorded' | 'edited' | 'conflicting_copy';
  direction: Direction | null;
  senderLabel: string | null;
  receivedAt: string;
  sentAt: string | null;
  text: string;
  textSha256: string;
  unsupportedContent: string[];
}

export interface CaptureRenderer {
  render(input: CaptureRenderInput): Promise<Uint8Array>;
}
