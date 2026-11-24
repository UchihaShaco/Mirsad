import type { Clock } from '../../src/ports/clock.ts';

export const DEFAULT_TEST_TIME = '2026-11-21T08:00:00.000Z';

/** A clock tests move by hand. Time never passes on its own. */
export class FakeClock implements Clock {
  private current: number;
  private readonly alarms = new Set<{ at: number; wake: () => void }>();

  constructor(start: string = DEFAULT_TEST_TIME) {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.set(new Date(this.current + ms).toISOString());
  }

  set(iso: string): void {
    this.current = Date.parse(iso);
    for (const alarm of [...this.alarms]) {
      if (alarm.at <= this.current) {
        this.alarms.delete(alarm);
        alarm.wake();
      }
    }
  }

  after(ms: number, wake: () => void): () => void {
    const alarm = { at: this.current + ms, wake };
    this.alarms.add(alarm);
    return () => this.alarms.delete(alarm);
  }
}
