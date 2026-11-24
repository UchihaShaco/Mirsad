/** Source of the current time. Tests inject a fake clock; nothing else reads the system time. */
export interface Clock {
  now(): Date;
  /** When supplied, timers advance with this clock (including manually controlled clocks). */
  after?(ms: number, wake: () => void): () => void;
}

export const systemClock = {
  now: () => new Date(),
  after(ms: number, wake: () => void): () => void {
    const timer = setTimeout(wake, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
} satisfies Clock;
