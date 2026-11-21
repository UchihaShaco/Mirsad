/** A latch tests close with hold() and open with release(); waiters resume on release. */
export class Gate {
  private waiters: (() => void)[] = [];
  private closed = false;

  hold(): void {
    this.closed = true;
  }

  release(): void {
    this.closed = false;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resume of waiting) resume();
  }

  async pass(): Promise<void> {
    if (!this.closed) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  get waiting(): number {
    return this.waiters.length;
  }
}
