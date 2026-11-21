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

/** True only when the file exists, parses as JSON and matches the record schema. */
export function hasValidControlledTestRecord(file: string = CONTROLLED_TEST_RECORD_PATH): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  try {
    return ControlledTestRecord.safeParse(JSON.parse(raw)).success;
  } catch {
    return false;
  }
}
