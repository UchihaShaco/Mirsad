/**
 * Shape of docs/telegram/controlled-test-record.json (design sections 13 and 14). The record is written by a
 * person after an approved live test; no code path in Mirsad creates it.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const CONTROLLED_TEST_RECORD_PATH = fileURLToPath(
  new URL('../../docs/telegram/controlled-test-record.json', import.meta.url),
);

const result = z.enum(['passed', 'failed', 'not_observed']);

export const ControlledTestRecord = z.object({
  approvalReference: z.string().trim().min(3).max(200),
  testDate: z.iso.date(),
  scope: z.object({
    businessConnectionId: z.string().min(1),
    chatIds: z.array(z.string().min(1)).min(1),
  }),
  eventCoverage: z
    .array(
      z.object({
        event: z.string().min(1),
        fixtureReplay: result,
        liveCapture: result,
        notes: z.string().optional(),
      }),
    )
    .min(1),
  manualReply: z.object({ result, notes: z.string().optional() }),
});
export type ControlledTestRecord = z.infer<typeof ControlledTestRecord>;

/**
 * True only when the record documents a verified test: the manual reply passed, at least one event was
 * captured live and no event failed in either column.
 */
export function isControlledTestVerified(record: ControlledTestRecord): boolean {
  const events = record.eventCoverage;
  return (
    record.manualReply.result === 'passed' &&
    events.some((e) => e.liveCapture === 'passed') &&
    events.every((e) => e.liveCapture !== 'failed' && e.fixtureReplay !== 'failed')
  );
}

/**
 * True only when the file exists, parses as JSON, matches the record schema and documents a verified test.
 * When `expectedApprovalReference` is given, the record's approval reference must match it.
 */
export function hasValidControlledTestRecord(
  file: string = CONTROLLED_TEST_RECORD_PATH,
  expectedApprovalReference?: string,
): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  let parsed: ReturnType<typeof ControlledTestRecord.safeParse>;
  try {
    parsed = ControlledTestRecord.safeParse(JSON.parse(raw));
  } catch {
    return false;
  }
  if (!parsed.success || !isControlledTestVerified(parsed.data)) return false;
  return expectedApprovalReference === undefined || parsed.data.approvalReference === expectedApprovalReference;
}
