import type { CaptureRenderer, CaptureRenderInput } from '../../src/ports/capture-renderer.ts';
import { Gate } from './gate.ts';

/** Wraps the real renderer so tests can hold, release and fail renders and inspect inputs. */
export class ControllableRenderer implements CaptureRenderer {
  readonly inputs: CaptureRenderInput[] = [];
  private readonly gate = new Gate();
  private failuresLeft = 0;

  constructor(private readonly inner: CaptureRenderer) {}

  hold(): void {
    this.gate.hold();
  }

  release(): void {
    this.gate.release();
  }

  failNext(count = 1): void {
    this.failuresLeft += count;
  }

  /** Number of renders currently blocked by hold(). */
  get waiting(): number {
    return this.gate.waiting;
  }

  async render(input: CaptureRenderInput): Promise<Uint8Array> {
    this.inputs.push(input);
    await this.gate.pass();
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('render_failed_by_test');
    }
    return this.inner.render(input);
  }
}
