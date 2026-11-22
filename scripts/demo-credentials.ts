/**
 * `npm run demo:credentials`: prints, for the configured data directory (MIRSAD_DATA_DIR, default ./data), a dashboard
 * sign-in link for each demo officer and the names of the environment variables the headless client and the replay
 * script read. The tokens go only to the terminal of the person who runs it: nothing is logged or written to a file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { DEMO_CREDENTIALS_FILE, type DemoCredentials } from '../src/identity/seed.ts';

const ENV_FILE = path.resolve(import.meta.dirname, '..', '.env');

const Entry = z.object({ id: z.string(), displayName: z.string(), token: z.string().min(1) });
const CredentialsFile = z.object({
  workspaceId: z.string(),
  officers: z.array(Entry).min(1),
  connector: Entry.extend({ captureMethod: z.literal('fixture_replay') }),
  accounts: z.array(z.object({ source: z.literal('telegram'), externalAccountId: z.string(), isIntake: z.boolean() })),
});

/** What each local client reads; unset token variables fall back to demo-credentials.json in the data directory. */
const CLIENT_VARIABLES = [
  { client: 'Headless client (npx tsx examples/headless-client/run.ts)', names: ['MIRSAD_BASE_URL', 'MIRSAD_OFFICER_TOKEN', 'MIRSAD_CONNECTOR_TOKEN', 'MIRSAD_DATA_DIR'] },
  { client: 'Fixture replay (npm run replay -- <fixture>)', names: ['MIRSAD_BASE_URL', 'MIRSAD_CONNECTOR_TOKEN', 'MIRSAD_DATA_DIR'] },
] as const;

/** The demo seed's credentials for `dataDir`. Throws, naming the file and never a token, when they are missing or malformed. */
export function readDemoCredentials(dataDir: string): DemoCredentials {
  const file = path.join(dataDir, DEMO_CREDENTIALS_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`no demo credentials at ${file}: start Mirsad once with the demo seed on (npm run demo) to create them`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const parsed = CredentialsFile.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} does not hold demo credentials`);
  return parsed.data;
}

/** `http://<host>:<port>` for the configured loopback host; an IPv6 host is bracketed. */
export function dashboardBaseUrl(config: { host: string; port: number }): string {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}`;
}

/**
 * One sign-in link per officer. The token sits in the URL fragment, which the browser never sends to the server: the
 * dashboard reads it once, removes it from the address bar and sends it only in the Authorization header.
 */
export function signInLines(credentials: DemoCredentials, baseUrl: string): string[] {
  return [
    'Dashboard sign-in links. Each carries an officer token: keep them to yourself.',
    ...credentials.officers.map((officer) => `  ${officer.displayName}: ${baseUrl}/#token=${encodeURIComponent(officer.token)}`),
    'The token is in the URL fragment, which the browser never sends to the server; the dashboard moves it into the Authorization header.',
    '',
    'Environment variables the local clients read (an unset token variable falls back to demo-credentials.json in the data directory):',
    ...CLIENT_VARIABLES.map(({ client, names }) => `  ${client}: ${names.join(', ')}`),
  ];
}

function main(): number {
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const config = loadConfig(process.env);
  const credentials = readDemoCredentials(config.dataDir);
  const portNote = config.port === 0 ? ['MIRSAD_PORT is 0: replace the port with the one in the mirsad_started log line.'] : [];
  process.stdout.write(`${[`Data directory: ${config.dataDir}`, ...portNote, '', ...signInLines(credentials, dashboardBaseUrl(config))].join('\n')}\n`);
  return 0;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync.native(entry) === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = main();
  } catch (error) {
    // Config errors name the variable and the rule; credential errors name the file. Neither carries a token.
    process.stderr.write(`demo:credentials failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
