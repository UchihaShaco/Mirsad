/** Structured logging. Fields are IDs, codes, counts, lengths and durations only (design section 16). */
export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}
