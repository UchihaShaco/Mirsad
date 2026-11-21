/** `npm run replay -- <fixture.json>`: posts a synthetic Telegram fixture to a running Mirsad instance. */
import fs from 'node:fs';
import path from 'node:path';
import { replayFixture, validateFixture, type ReplayReport } from '../src/adapters/replay.ts';
import type { TelegramFixture } from '../src/adapters/telegram/types.ts';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_DATA_DIR = './data';
const CREDENTIALS_FILE = 'demo-credentials.json';
const DEMO_ACCOUNTS = { intake: 'tg-demo-intake', officer: 'tg-demo-officer' } as const;

function connectorToken(): string {
  const fromEnv = process.env.MIRSAD_CONNECTOR_TOKEN;
  if (fromEnv) return fromEnv;
  const file = path.join(process.env.MIRSAD_DATA_DIR ?? DEFAULT_DATA_DIR, CREDENTIALS_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`no connector token: set MIRSAD_CONNECTOR_TOKEN or start Mirsad once so ${file} exists`);
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { connector?: { token?: string } };
  const token = parsed.connector?.token;
  if (!token) throw new Error(`${file} has no connector token`);
  return token;
}

function formatReport(report: ReplayReport): string {
  const rows = report.events.map((e) => [e.sourceEventId, String(e.status), e.result, e.chatId ?? '-', e.messageId ?? '-']);
  const header = ['sourceEventId', 'status', 'result', 'chatId', 'messageId'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(header), ...rows.map(line), `skipped updates: ${report.skippedUpdates}`].join('\n');
}

async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: npm run replay -- <fixture.json>\n');
    return 2;
  }
  const fixture: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateFixture(fixture);
  if (problems.length > 0) {
    process.stderr.write(`replay refused:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }
  const report = await replayFixture(fixture as TelegramFixture, {
    baseUrl: process.env.MIRSAD_BASE_URL ?? DEFAULT_BASE_URL,
    connectorToken: connectorToken(),
    accounts: DEMO_ACCOUNTS,
  });
  process.stdout.write(`${formatReport(report)}\n`);
  return report.events.every((e) => e.status === 200 || e.status === 201) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`replay failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  },
);
