import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasValidControlledTestRecord, readControlledTestRecord } from '../../src/contract/controlled-test-record.ts';
import { loadConfig } from '../../src/config.ts';

function passingRecord() {
  return {
    approvalReference: 'APPROVAL-2026-001',
    testDate: '2026-11-20',
    tester: 'Demo Officer 1',
    scope: { businessConnectionId: 'bc-1', chatIds: ['100'] },
    eventCoverage: [
      { event: 'business_message', fixtureReplay: 'passed', liveCapture: 'passed' },
      { event: 'edited_business_message', fixtureReplay: 'passed', liveCapture: 'not_observed' },
    ],
    manualReply: { result: 'passed' },
  };
}

describe('controlled-test record gate', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-record-'));
    file = path.join(dir, 'controlled-test-record.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (content: unknown) =>
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));

  it('accepts a record documenting a passed test', () => {
    write(passingRecord());
    expect(hasValidControlledTestRecord(file)).toBe(true);
  });

  it('rejects a record whose manual reply failed', () => {
    write({ ...passingRecord(), manualReply: { result: 'failed' } });
    expect(hasValidControlledTestRecord(file)).toBe(false);
  });

  it('rejects a record whose manual reply was not observed', () => {
    write({ ...passingRecord(), manualReply: { result: 'not_observed' } });
    expect(hasValidControlledTestRecord(file)).toBe(false);
  });

  it('rejects a record with no event captured live', () => {
    const record = passingRecord();
    write({
      ...record,
      eventCoverage: record.eventCoverage.map((e) => ({ ...e, liveCapture: 'not_observed' })),
    });
    expect(hasValidControlledTestRecord(file)).toBe(false);
  });

  it('rejects a record with any failed event', () => {
    const record = passingRecord();
    write({
      ...record,
      eventCoverage: [...record.eventCoverage, { event: 'x', fixtureReplay: 'failed', liveCapture: 'passed' }],
    });
    expect(hasValidControlledTestRecord(file)).toBe(false);
  });

  it('rejects malformed JSON', () => {
    write('{ not json');
    expect(hasValidControlledTestRecord(file)).toBe(false);
  });

  it('rejects a record whose approval reference differs from the expected one', () => {
    write(passingRecord());
    expect(hasValidControlledTestRecord(file, 'APPROVAL-2026-001')).toBe(true);
    expect(hasValidControlledTestRecord(file, 'OTHER-REF')).toBe(false);
  });

  it('readControlledTestRecord returns null for a missing or invalid file and the record for a valid one', () => {
    expect(readControlledTestRecord(file)).toBeNull();
    write('{ not json');
    expect(readControlledTestRecord(file)).toBeNull();
    const { tester: _tester, ...withoutTester } = passingRecord();
    write(withoutTester);
    expect(readControlledTestRecord(file)).toBeNull();
    write({ ...passingRecord(), testDate: 'yesterday' });
    expect(readControlledTestRecord(file)).toBeNull();
    write(passingRecord());
    expect(readControlledTestRecord(file)).toEqual(passingRecord());
    const failed = { ...passingRecord(), manualReply: { result: 'failed' } };
    write(failed);
    expect(readControlledTestRecord(file)).toEqual(failed);
  });

  it('loadConfig opens the WhatsApp gate only with a valid record at MIRSAD_CONTROLLED_TEST_RECORD', () => {
    const env = { MIRSAD_WHATSAPP_IMPORT_ENABLED: 'true', MIRSAD_CONTROLLED_TEST_RECORD: file };
    expect(() => loadConfig(env)).toThrow(/MIRSAD_WHATSAPP_IMPORT_ENABLED/);
    write(passingRecord());
    const config = loadConfig(env);
    expect(config.whatsappImportEnabled).toBe(true);
    expect(config.controlledTestRecordPath).toBe(file);
    expect(() => loadConfig({ ...env, TELEGRAM_APPROVAL_REFERENCE: 'OTHER-REF' })).toThrow(
      /MIRSAD_WHATSAPP_IMPORT_ENABLED/,
    );
    const { tester: _tester, ...withoutTester } = passingRecord();
    write(withoutTester);
    expect(() => loadConfig(env)).toThrow(/MIRSAD_WHATSAPP_IMPORT_ENABLED/);
    write({ ...passingRecord(), manualReply: { result: 'failed' } });
    expect(() => loadConfig(env)).toThrow(/MIRSAD_WHATSAPP_IMPORT_ENABLED/);
    write(passingRecord());
    const elsewhere = path.join(dir, 'other-record.json');
    expect(() => loadConfig({ ...env, MIRSAD_CONTROLLED_TEST_RECORD: elsewhere })).toThrow(
      /MIRSAD_WHATSAPP_IMPORT_ENABLED/,
    );
  });
});
