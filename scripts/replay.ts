/** `npm run replay -- <fixture.json>`: posts a synthetic Telegram fixture to a running Mirsad instance. */
import fs from 'node:fs';
import path from 'node:path';
import { replayFixture, validateFixture, type ReplayReport } from '../src/adapters/replay.ts';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { isEntryPoint, loadDotEnvIfPresent } from './entry-point.ts';

const CREDENTIALS_FILE = 'demo-credentials.json';
const credentialsSchema = z.object({ connector: z.object({ token: z.string().min(1) }) });
const DEMO_ACCOUNTS = { intake: 'tg-demo-intake', officer: 'tg-demo-officer' } as const;

type Env = Record<string, string | undefined>;

export interface ReplayTarget {
  baseUrl: string;
  /** Where demo-credentials.json is looked for when MIRSAD_CONNECTOR_TOKEN is unset. */
  dataDir: string;
}

/**
 * The instance the configuration describes, read with the server's own rules and defaults: the address it listens on
 * (MIRSAD_HOST, MIRSAD_PORT) unless MIRSAD_BASE_URL is set, and its data directory (MIRSAD_DATA_DIR). So replay reaches
 * the instance `npm run demo` started with the same environment and .env.
 */
export function replayTarget(env: Env): ReplayTarget {
  const config = loadConfig(env);
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return { baseUrl: env.MIRSAD_BASE_URL?.trim() || `http://${host}:${config.port}`, dataDir: config.dataDir };
}

function connectorToken(env: Env, dataDir: string): string {
  const fromEnv = env.MIRSAD_CONNECTOR_TOKEN;
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, CREDENTIALS_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`no connector token: set MIRSAD_CONNECTOR_TOKEN or start Mirsad once so ${file} exists`);
  }
  const parsed = credentialsSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`${file} has no connector token`);
  return parsed.data.connector.token;
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
  const target = replayTarget(process.env);
  const report = await replayFixture(fixture, {
    baseUrl: target.baseUrl,
    connectorToken: connectorToken(process.env, target.dataDir),
    accounts: DEMO_ACCOUNTS,
  });
  process.stdout.write(`${formatReport(report)}\n`);
  return report.events.every((e) => e.status === 200 || e.status === 201) ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  loadDotEnvIfPresent();
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`replay failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    },
  );
}
