import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatChecklist, runWalkthrough, type WalkthroughReport } from '../../scripts/demo-walkthrough.ts';
import { readDemoCredentials, signInLines } from '../../scripts/demo-credentials.ts';
import type { DemoCredentials } from '../../src/identity/seed.ts';

/** Two full walkthrough runs start a real instance each; on this machine one run takes several seconds. */
const WALKTHROUGH_TIMEOUT_MS = 180_000;
const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/telegram');

/** The checks the walkthrough must run, in this order (Task 13 controller decisions). */
const STEP_ORDER = [
  'service_healthy',
  'inbound_first_new_inbound',
  'officer_first_both_directions',
  'start_marker_contact_started',
  'capture_per_message',
  'replay_creates_no_duplicates',
  'edit_delete_separate_events',
  'batch_dispatch_per_chat_status',
  'quiet_review_one_note',
  'pause_and_resume',
  'take_over',
  'composer_blank_by_default',
  'simulated_send',
  'leave_unanswered',
  'capture_during_takeover',
  'watchlist_needs_review',
  'watchlist_approval_sender_match',
  'watchlist_cleared_new_evidence',
  'merchant_conflict_suspected_fraud',
  'stream_second_client',
  'outsider_gets_404',
  'restart_keeps_evidence',
];

/** Every message text in the shipped fixtures: none of it may appear in the printed checklist. */
function fixtureTexts(): string[] {
  const texts: string[] = [];
  for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) as { updates: Record<string, { text?: string } | undefined>[] };
    for (const update of fixture.updates) {
      for (const message of [update.business_message, update.edited_business_message]) {
        if (message?.text) texts.push(message.text);
      }
    }
  }
  return texts;
}

function stepOf(report: WalkthroughReport, id: string) {
  const step = report.steps.find((s) => s.id === id);
  if (!step) throw new Error(`no step ${id}`);
  return step;
}

describe('demo walkthrough', () => {
  it('the walkthrough passes on a clean start with the deterministic reviewer', async () => {
    const report = await runWalkthrough({ reviewer: 'deterministic' });

    expect(report.steps.map((s) => s.id)).toEqual(STEP_ORDER);
    expect(report.steps.filter((s) => !s.passed)).toEqual([]);
    expect(report).toMatchObject({ reviewer: 'deterministic', passed: true, exitCode: 0, kept: false });
    // A clean start: the temporary data directory was the instance's own, and it is gone afterwards.
    expect(fs.existsSync(report.dataDir)).toBe(false);

    const checklist = formatChecklist(report);
    expect(checklist.split('\n').filter((line) => line.startsWith('PASS  '))).toHaveLength(STEP_ORDER.length);
    expect(checklist).toMatch(/0 of 22 checks failed/);
    for (const text of fixtureTexts()) expect(checklist).not.toContain(text);
  }, WALKTHROUGH_TIMEOUT_MS);

  it('the walkthrough reports a failed step with a non-zero result', async () => {
    // With review switched off nothing can raise the findings the review checks expect.
    const report = await runWalkthrough({ reviewer: 'disabled', keep: true });
    try {
      expect(report).toMatchObject({ reviewer: 'disabled', passed: false, exitCode: 1, kept: true });
      expect(stepOf(report, 'quiet_review_one_note')).toMatchObject({ passed: false, detail: expect.stringMatching(/review unavailable/) });
      expect(stepOf(report, 'watchlist_needs_review').passed).toBe(false);
      // Evidence capture, officer control and persistence do not depend on the reviewer.
      for (const id of ['inbound_first_new_inbound', 'capture_per_message', 'simulated_send', 'leave_unanswered', 'restart_keeps_evidence']) {
        expect(stepOf(report, id).passed, id).toBe(true);
      }
      expect(formatChecklist(report)).toMatch(/^FAIL {2}quiet_review_one_note {2}/m);
      // --keep leaves the data directory, with the demo sign-in credentials, for inspection.
      expect(fs.existsSync(path.join(report.dataDir, 'demo-credentials.json'))).toBe(true);
    } finally {
      fs.rmSync(report.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, WALKTHROUGH_TIMEOUT_MS);
});

describe('demo credentials', () => {
  const credentials: DemoCredentials = {
    workspaceId: 'ws_0000',
    officers: [
      { id: 'prn_0001', displayName: 'Demo Officer 1', token: 'mso_first-demo-token' },
      { id: 'prn_0002', displayName: 'Demo Officer 2', token: 'mso_second-demo-token' },
    ],
    connector: { id: 'prn_0003', displayName: 'Demo fixture connector', token: 'msc_connector-demo-token', captureMethod: 'fixture_replay' },
    accounts: [],
  };

  it('prints a dashboard sign-in link with a #token= fragment per demo officer and the variable names the scripts read', () => {
    const output = signInLines(credentials, 'http://127.0.0.1:8787').join('\n');

    expect(output).toContain('Demo Officer 1: http://127.0.0.1:8787/#token=mso_first-demo-token');
    expect(output).toContain('Demo Officer 2: http://127.0.0.1:8787/#token=mso_second-demo-token');
    for (const name of ['MIRSAD_BASE_URL', 'MIRSAD_OFFICER_TOKEN', 'MIRSAD_CONNECTOR_TOKEN', 'MIRSAD_DATA_DIR']) expect(output).toContain(name);
    // Only names: the connector token is never printed, and no token goes into a query string.
    expect(output).not.toContain('msc_connector-demo-token');
    expect(output).not.toMatch(/\?token=/);
  });

  it('reads the credentials of a data directory and says how to create them when they are missing', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-credentials-'));
    try {
      expect(() => readDemoCredentials(dataDir)).toThrow(/npm run demo/);
      fs.writeFileSync(path.join(dataDir, 'demo-credentials.json'), JSON.stringify(credentials));
      expect(readDemoCredentials(dataDir).officers.map((o) => o.displayName)).toEqual(['Demo Officer 1', 'Demo Officer 2']);
      fs.writeFileSync(path.join(dataDir, 'demo-credentials.json'), JSON.stringify({ officers: [] }));
      expect(() => readDemoCredentials(dataDir)).toThrow(/demo-credentials\.json/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
