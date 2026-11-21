import type { Clock } from '../../src/ports/clock.ts';

export const DEFAULT_TEST_TIME = '2026-11-21T08:00:00.000Z';

/** A clock tests move by hand. Time never passes on its own. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: string = DEFAULT_TEST_TIME) {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(iso: string): void {
    this.current = Date.parse(iso);
  }
}
