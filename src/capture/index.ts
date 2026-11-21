// Stub until Task 3 installs the real renderer. The signature is final.
import type { CaptureRenderer } from '../ports/capture-renderer.ts';

export function createDefaultRenderer(): CaptureRenderer {
  return {
    async render(): Promise<Uint8Array> {
      throw new Error('renderer_not_installed');
    },
  };
}
