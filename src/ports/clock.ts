/** Source of the current time. Tests inject a fake clock; nothing else reads the system time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
