/** JSON-lines logger (design section 16). Callers pass IDs, codes, counts and durations, never content. */
import { systemClock, type Clock } from '../ports/clock.ts';
import type { LogFields, Logger } from '../ports/logger.ts';

export interface JsonLoggerOptions {
  write?: (line: string) => void;
  clock?: Clock;
}

export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const clock = options.clock ?? systemClock;
  const emit = (level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}) =>
    write(JSON.stringify({ ...fields, ts: clock.now().toISOString(), level, event }));
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
