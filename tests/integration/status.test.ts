/**
 * GET /v1/status and the readiness states (design section 13), and the WhatsApp gate (section 14). The controlled-test
 * record and readiness file live in a temporary directory; the example record is the one shipped in docs/telegram.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { Status } from '../../src/contract/schemas.ts';
import { readStatus, type StatusDeps } from '../../src/services/status.ts';
import { DATABASE_FILE, openDatabase, type Db } from '../../src/storage/db.ts';
import { runReadiness } from '../../scripts/telegram-readiness.ts';
import { envelope, recorded, uniqueId } from '../helpers/events.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const EXAMPLE_RECORD = path.resolve(import.meta.dirname, '../../docs/telegram/controlled-test-record.example.json');
const FIXTURES_DIR = path.resolve(import.meta.dirname, '../../fixtures/telegram');
const READINESS_CHECK_IDS = [
  'inbound_first_new_inbound',
  'officer_first_both_directions',
  'capture_per_message',
  'edit_delete_separate_events',
  'redelivery_creates_nothing',
  'outgoing_labelled_outgoing',
  'takeover_simulated_send',
  'live_connector_gated',
];

let h: TestHarness;
let db: Db;
let tmp: string;
let recordFile: string;

const exampleRecord = (): Record<string, unknown> => JSON.parse(fs.readFileSync(EXAMPLE_RECORD, 'utf8')) as Record<string, unknown>;
const writeJson = (file: string, value: unknown): void => fs.writeFileSync(file, JSON.stringify(value, null, 2));

function deps(over: Partial<StatusDeps> = {}): StatusDeps {
  return { config: h.app.config, db, reviewer: h.reviewer, startedAt: '2026-11-21T08:00:00.000Z', liveConnectorRunning: false, ...over };
}

function readinessFile(checks: { id: string; passed: boolean }[], state = 'ready_for_controlled_test'): string {
  const file = path.join(tmp, `readiness-${uniqueId()}.json`);
  writeJson(file, {
    state,
    recordedAt: '2026-11-22T09:30:00.000Z',
    checks: checks.map((c) => ({ ...c, title: `Check ${c.id}`, detail: 'counts only' })),
  });
  return file;
}

async function httpStatus(): Promise<Status> {
  const res = await h.http(h.tokens.officerA).get('/v1/status');
  expect(res.status, res.text).toBe(200);
  return Status.parse(res.body.data);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-status-'));
  recordFile = path.join(tmp, 'controlled-test-record.json');
  h = await startHarness({ config: { controlledTestRecordPath: recordFile } });
  db = openDatabase(path.join(h.dataDir, DATABASE_FILE));
});

afterAll(async () => {
  db.close();
  await h.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('status', () => {
  it('status reports the live connector disabled and readiness from the readiness file', async () => {
    const first = await httpStatus();
    expect(first.service.startedAt).toBe('2026-11-21T08:00:00.000Z');
    expect(first.reviewer).toEqual({ kind: 'deterministic', modelId: null, reachable: true });
    expect(first.storage).toEqual({ database: 'ok', evidenceDirectory: 'not_created' });
    expect(first.channels.telegram).toMatchObject({ fixtureReplay: 'available', liveConnector: 'disabled' });
    expect((await h.http(h.tokens.connector).get('/v1/status')).status).toBe(403);

    // Worker counts come from the queues: a held render is pending until it is released.
    h.renderer.hold();
    await h.http(h.tokens.connector).post('/v1/ingest', envelope(h.accounts.intake, uniqueId('status-'), recorded({ messageId: 1 })));
    expect((await httpStatus()).workers.capture.pending).toBe(1);
    h.renderer.release();
    await h.drain();
    const settled = await httpStatus();
    expect(settled.workers).toEqual({ capture: { pending: 0, failed: 0 }, review: { pending: 0, running: 0, unavailable: 0 } });
    expect(settled.storage.evidenceDirectory).toBe('ok');

    const telegram = async (file: string) => (await readStatus(deps({ readinessFile: file }))).channels.telegram;
    expect(await telegram(path.join(tmp, 'no-readiness.json'))).toMatchObject({ readiness: 'not_assessed', readinessRecordedAt: null });
    const allPassed = READINESS_CHECK_IDS.map((id) => ({ id, passed: true }));
    expect(await telegram(readinessFile(allPassed))).toMatchObject({
      readiness: 'ready_for_controlled_test',
      readinessRecordedAt: '2026-11-22T09:30:00.000Z',
    });
    const oneFailed = allPassed.map((c, i) => (i === 3 ? { ...c, passed: false } : c));
    expect((await telegram(readinessFile(oneFailed, 'not_ready'))).readiness).toBe('not_assessed');
    expect((await telegram(readinessFile(oneFailed))).readiness).toBe('not_assessed');
    expect((await telegram(readinessFile(allPassed.slice(1)))).readiness).toBe('not_assessed');
    const malformed = path.join(tmp, 'malformed-readiness.json');
    fs.writeFileSync(malformed, '{ "state": "ready_for_controlled_test"');
    expect((await telegram(malformed)).readiness).toBe('not_assessed');
    expect((await readStatus(deps({ liveConnectorRunning: true }))).channels.telegram.liveConnector).toBe('enabled');
  });

  it('Controlled test verified is reported only with a valid controlled-test record', async () => {
    const verified = async () => (await httpStatus()).channels.telegram.readiness === 'controlled_test_verified';
    fs.rmSync(recordFile, { force: true });
    expect(await verified()).toBe(false);
    fs.writeFileSync(recordFile, '{ "approvalReference": ');
    expect(await verified()).toBe(false);
    writeJson(recordFile, { ...exampleRecord(), tester: '' });
    expect(await verified()).toBe(false);
    writeJson(recordFile, { ...exampleRecord(), manualReply: { result: 'failed' } });
    expect(await verified()).toBe(false);

    writeJson(recordFile, exampleRecord());
    const telegram = (await httpStatus()).channels.telegram;
    expect(telegram).toMatchObject({ readiness: 'controlled_test_verified', readinessRecordedAt: `${String(exampleRecord().testDate)}T00:00:00.000Z` });

    // When an approval reference is configured, the record must carry that same reference.
    const config = h.app.config;
    const otherReference = { ...config, telegram: { ...config.telegram, approvalReference: 'TEST-APPROVAL-OTHER' } };
    expect((await readStatus(deps({ config: otherReference }))).channels.telegram.readiness).not.toBe('controlled_test_verified');
    fs.rmSync(recordFile, { force: true });
  });

  it('the WhatsApp gate cannot be opened without that record', async () => {
    const env = { MIRSAD_DATA_DIR: tmp, MIRSAD_WHATSAPP_IMPORT_ENABLED: 'true', MIRSAD_CONTROLLED_TEST_RECORD: recordFile };
    fs.rmSync(recordFile, { force: true });
    expect(() => loadConfig(env)).toThrow(ConfigError);
    writeJson(recordFile, { ...exampleRecord(), eventCoverage: [{ event: 'business_message incoming', fixtureReplay: 'passed', liveCapture: 'failed' }] });
    expect(() => loadConfig(env)).toThrow(/MIRSAD_WHATSAPP_IMPORT_ENABLED/);

    // While the gate is closed, status says so and intake refuses WhatsApp events.
    expect((await httpStatus()).channels.whatsapp).toEqual({ status: 'not_started', gate: 'closed_until_telegram_controlled_test_verified' });
    const whatsapp = envelope({ source: 'whatsapp', externalAccountId: 'wa-test-1' }, uniqueId('wa-'), recorded({ messageId: 1 }));
    const refused = await h.http(h.tokens.connector).post('/v1/ingest', whatsapp);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('channel_not_enabled');

    // A verified record makes the gate available; it opens only when the import flag is also set.
    writeJson(recordFile, exampleRecord());
    expect((await httpStatus()).channels.whatsapp.gate).toBe('closed_until_import_enabled');
    const opened = loadConfig(env);
    expect(opened.whatsappImportEnabled).toBe(true);
    expect((await readStatus(deps({ config: opened }))).channels.whatsapp).toEqual({ status: 'not_started', gate: 'open' });
    fs.rmSync(recordFile, { force: true });
  });

  it('the readiness run passes all eight local checks and writes readiness.json and readiness.md', async () => {
    const outputDir = path.join(tmp, 'readiness-run');
    const record = await runReadiness({ outputDir, now: () => new Date('2026-11-22T10:00:00.000Z') });
    expect(record.checks.map((c) => [c.id, c.passed, c.detail])).toEqual(READINESS_CHECK_IDS.map((id) => [id, true, expect.any(String)]));
    expect(record.state).toBe('ready_for_controlled_test');
    const json = fs.readFileSync(path.join(outputDir, 'readiness.json'), 'utf8');
    expect(JSON.parse(json)).toEqual(record);
    const markdown = fs.readFileSync(path.join(outputDir, 'readiness.md'), 'utf8');
    for (const section of ['## Fixture replay', '## Live capture', '## Manual officer reply']) expect(markdown).toContain(section);
    expect(markdown).toContain('Ready for controlled test');
    // IDs, results and counts only: no fixture text, names, links or tokens.
    for (const leaked of ['See you at five', 'Test Contact', 'Test Owner', 'pay.shop.test', 'Bearer', 'mso_', 'msc_']) {
      expect(json).not.toContain(leaked);
      expect(markdown).not.toContain(leaked);
    }
    expect((await readStatus(deps({ readinessFile: path.join(outputDir, 'readiness.json') }))).channels.telegram).toMatchObject({
      readiness: 'ready_for_controlled_test',
      readinessRecordedAt: '2026-11-22T10:00:00.000Z',
    });
  });

  it('the readiness run records not_ready when a local check fails', async () => {
    // A fixture set whose officer-first conversation lost the officer's message: both messages come from the contact.
    const fixturesDir = path.join(tmp, 'broken-fixtures');
    fs.cpSync(FIXTURES_DIR, fixturesDir, { recursive: true });
    const officerFirst = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'officer-first.json'), 'utf8')) as {
      updates: { business_message: { from: Record<string, unknown> } }[];
    };
    const contact = officerFirst.updates[1]?.business_message.from;
    const broken = { ...officerFirst, updates: officerFirst.updates.map((u) => ({ ...u, business_message: { ...u.business_message, from: contact } })) };
    writeJson(path.join(fixturesDir, 'officer-first.json'), broken);

    const outputDir = path.join(tmp, 'readiness-broken');
    const record = await runReadiness({ outputDir, fixturesDir });
    expect(record.state).toBe('not_ready');
    expect(record.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['officer_first_both_directions']);
    expect(fs.readFileSync(path.join(outputDir, 'readiness.md'), 'utf8')).toContain('Not ready');
    expect((await readStatus(deps({ readinessFile: path.join(outputDir, 'readiness.json') }))).channels.telegram.readiness).toBe('not_assessed');
  });
});
