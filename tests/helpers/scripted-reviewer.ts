import {
  ReviewerUnavailableError,
  type ExtractedItem,
  type ReviewRequest,
  type Reviewer,
} from '../../src/ports/reviewer.ts';
import { Gate } from './gate.ts';

export type ReviewResponder = (
  request: ReviewRequest,
) => { items: ExtractedItem[] } | Promise<{ items: ExtractedItem[] }>;

/** A test reviewer: deterministic rules by default, with hold, scripted answers and failures. */
export class ScriptedReviewer implements Reviewer {
  readonly name = 'scripted';
  readonly calls: ReviewRequest[] = [];
  private readonly gate = new Gate();
  private responder: ReviewResponder | null = null;
  private readonly failures: string[] = [];

  constructor(private readonly fallback: Reviewer) {}

  hold(): void {
    this.gate.hold();
  }

  release(): void {
    this.gate.release();
  }

  /** Replace the default rules; pass null to go back to them. */
  respond(fn: ReviewResponder | null): void {
    this.responder = fn;
  }

  failNext(code = 'reviewer_failed_by_test'): void {
    this.failures.push(code);
  }

  /** Number of reviews currently blocked by hold(). */
  get waiting(): number {
    return this.gate.waiting;
  }

  async review(request: ReviewRequest, signal: AbortSignal): Promise<{ items: ExtractedItem[] }> {
    this.calls.push(request);
    await this.gate.pass();
    const failure = this.failures.shift();
    if (failure !== undefined) throw new ReviewerUnavailableError(failure);
    if (this.responder) return this.responder(request);
    return this.fallback.review(request, signal);
  }

  async health(): Promise<{ reachable: boolean; modelId: string | null }> {
    return { reachable: true, modelId: null };
  }
}
