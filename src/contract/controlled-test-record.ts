/**
 * Shape of the Telegram controlled-test record named by MIRSAD_CONTROLLED_TEST_RECORD (design sections 13 and 14).
 * The record is written by a person after an approved live test; no code path in Mirsad creates it.
 */
import fs from 'node:fs';
import { z } from 'zod';

/** Default location of the record (`MIRSAD_CONTROLLED_TEST_RECORD`), relative to the project root. */
export const DEFAULT_CONTROLLED_TEST_RECORD = 'docs/telegram/controlled-test-record.json';
/**
 * Approval references starting with this mark the shipped example (docs/telegram/controlled-test-record.example.json).
 * Such a record documents no test, so it never counts as verified, even copied to the record path.
 */
export const EXAMPLE_APPROVAL_PREFIX = 'EXAMPLE-ONLY-';

const result = z.enum(['passed', 'failed', 'not_observed']);

export const ControlledTestRecord = z.object({
  approvalReference: z.string().trim().min(3).max(200),
  testDate: z.iso.date(),
  tester: z.string().trim().min(1).max(200),
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

/** The record at `file`, or null when the file is missing, is not JSON or does not match the schema. */
export function readControlledTestRecord(file: string): ControlledTestRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ControlledTestRecord.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * True only when the file holds a valid record that documents a verified test and is not the shipped example. When
 * `expectedApprovalReference` is given, the record's approval reference must match it.
 */
export function hasValidControlledTestRecord(file: string, expectedApprovalReference?: string): boolean {
  const record = readControlledTestRecord(file);
  if (record === null || !isControlledTestVerified(record)) return false;
  if (record.approvalReference.startsWith(EXAMPLE_APPROVAL_PREFIX)) return false;
  return expectedApprovalReference === undefined || record.approvalReference === expectedApprovalReference;
}
