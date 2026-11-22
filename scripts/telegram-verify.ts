/**
 * `npm run telegram:verify [-- --discover-connections]`: endpoint and connection verification for the Telegram live
 * connector (design section 19.8). It uses the real Bot API only when TELEGRAM_BOT_TOKEN is set; without it, it
 * prints what is missing and exits 1. It reads no messages and never prints the token.
 *
 * --discover-connections lists the business connections Telegram has pending (connection ID, owner user ID, enabled,
 * rights) with one short poll that confirms nothing, so the values for .env and telegram:provision can be found. That
 * poll leaves allowed_updates narrowed to business_connection until the connector's first poll, so message updates
 * created in between are never queued (docs/telegram/setup.md, step 4).
 */
import fs from 'node:fs';
import path from 'node:path';
import { BotApiError, createBotApi, type BotApi } from '../src/adapters/telegram/bot-api.ts';
import { findLiveBindings } from '../src/adapters/telegram/live-connector.ts';
import { discoverConnections, verifyConnection, type ConnectionDiscovery, type VerificationReport } from '../src/adapters/telegram/verify.ts';
import { ConfigError, loadConfig, type Config } from '../src/config.ts';
import { DATABASE_FILE, openDatabase } from '../src/storage/db.ts';
import { isEntryPoint, loadDotEnvIfPresent } from './entry-point.ts';

const DISCOVER_FLAG = '--discover-connections';

export interface VerifyRunOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  write: (text: string) => void;
  /** Replaces the real Bot API client (tests point it at a fake server). */
  botApi?: BotApi;
}

/** externalAccountId of the one provisioned live channel account, or null; never creates a database. */
function provisionedOwner(dataDir: string): string | null {
  const file = path.join(dataDir, DATABASE_FILE);
  if (!fs.existsSync(file)) return null;
  const db = openDatabase(file);
  try {
    const bindings = db.transaction((tx) => findLiveBindings(tx));
    return bindings.length === 1 ? (bindings[0]?.account.external_account_id ?? null) : null;
  } finally {
    db.close();
  }
}

function missingSettings(telegram: Config['telegram']): string {
  const unset = [
    telegram.botToken === null ? 'TELEGRAM_BOT_TOKEN (required to call the Bot API)' : null,
    telegram.approvedConnectionId === null ? 'TELEGRAM_APPROVED_CONNECTION_ID' : null,
    telegram.approvedChatIds.length === 0 ? 'TELEGRAM_APPROVED_CHAT_IDS' : null,
    telegram.approvalReference === null ? 'TELEGRAM_APPROVAL_REFERENCE' : null,
  ].filter((line): line is string => line !== null);
  return `Telegram verification cannot run. Not set:\n${unset.map((line) => `  - ${line}`).join('\n')}\nSee docs/telegram/setup.md.\n`;
}

function formatReport(report: VerificationReport): string {
  const width = Math.max(...report.checks.map((c) => c.id.length));
  const lines = report.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'}  ${c.id.padEnd(width)}  ${c.detail}`);
  const failed = report.checks.filter((c) => !c.passed).length;
  const verdict = report.ready ? 'Verification passed.' : `Verification failed: ${failed} check(s) did not pass.`;
  return `${lines.join('\n')}\n${verdict}\n`;
}

function formatDiscovery(discovery: ConnectionDiscovery): string {
  const lines = discovery.connections.map(
    (c) => `connection ${c.id}  owner user ID ${c.ownerUserId}  ${c.enabled ? 'enabled' : 'disabled'}  rights: ${c.rightsGranted.join(', ') || 'none'}`,
  );
  const found = lines.length > 0 ? lines.join('\n') : 'No business connection update is pending. Ask the owner to connect the bot, then run this again.';
  return `${found}\nOther pending updates (not read): ${discovery.otherUpdates}\n`;
}

/** Returns the exit code: 0 verified (or discovery listed), 1 otherwise. */
export async function runVerify(options: VerifyRunOptions): Promise<number> {
  let config: Config;
  try {
    config = loadConfig(options.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    options.write(`Configuration problem: ${error.message}\n`);
    return 1;
  }
  const token = config.telegram.botToken;
  if (token === null) {
    options.write(missingSettings(config.telegram));
    return 1;
  }
  try {
    const api = options.botApi ?? createBotApi({ token });
    if (options.argv.includes(DISCOVER_FLAG)) {
      options.write(formatDiscovery(await discoverConnections(api)));
      return 0;
    }
    const report = await verifyConnection(api, config, { provisionedOwnerUserId: provisionedOwner(config.dataDir) });
    options.write(formatReport(report));
    return report.ready ? 0 : 1;
  } catch (error) {
    const reason = error instanceof BotApiError ? error.message : error instanceof Error ? error.message : 'unknown error';
    options.write(`Telegram verification failed: ${reason}\n`);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  loadDotEnvIfPresent();
  runVerify({ argv: process.argv.slice(2), env: process.env, write: (text) => process.stdout.write(text) }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('Telegram verification failed unexpectedly.\n');
      process.exitCode = 1;
    },
  );
}
