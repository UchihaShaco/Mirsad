/**
 * The default capture renderer (design section 9): draws the card, then writes the provenance tEXt chunks into the
 * PNG. It is a pure function of its input: no clock, no network, no reads other than the vendored font files.
 */
import type { CaptureRenderer, CaptureRenderInput } from '../ports/capture-renderer.ts';
import { drawCaptureCard } from './card.ts';
import { registerCaptureFonts } from './fonts.ts';
import { addTextChunks } from './png-metadata.ts';

/** The provenance every capture PNG carries; all values are server-generated IDs, times and hashes. */
function provenanceChunks(input: CaptureRenderInput): Record<string, string> {
  return {
    'Mirsad-Capture-Kind': input.captureKind,
    'Mirsad-Chat-Id': input.chatId,
    'Mirsad-Message-Id': input.messageId,
    'Mirsad-Message-Event-Id': input.messageEventId,
    'Mirsad-Received-At': input.receivedAt,
    'Mirsad-Text-SHA256': input.textSha256,
  };
}

export function createDefaultRenderer(): CaptureRenderer {
  registerCaptureFonts();
  return {
    async render(input: CaptureRenderInput): Promise<Uint8Array> {
      return addTextChunks(await drawCaptureCard(input), provenanceChunks(input));
    },
  };
}
