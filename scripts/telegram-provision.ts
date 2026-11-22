/**
 * `npm run telegram:provision -- --owner-user-id <id> [--officer <id or display name>]... [--workspace <id>]`
 *
 * Creates, in the local database, the Telegram live channel account (externalAccountId = the business owner's user
 * ID), the telegram_business_live connector principal and grants for the named officers. Prints IDs only. A new
 * connector token is written only to <dataDir>/telegram-live-credentials.json; it is never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findLiveBindings } from '../src/adapters/telegram/live-connector.ts';
import { loadConfig } from '../src/config.ts';
import { provisionPrincipal } from '../src/identity/provision.ts';
import { DATABASE_FILE, openDatabase, type Db, type Tx } from '../src/storage/db.ts';
import { findChannelAccount, grantAccount, insertChannelAccount } from '../src/storage/repos/principals.ts';
import type { PrincipalRow, WorkspaceRow } from '../src/storage/rows.ts';

export const LIVE_CREDENTIALS_FILE = 'telegram-live-credentials.json';
const CREDENTIALS_FILE_MODE = 0o600;
const TELEGRAM_USER_ID = /^[1-9]\d{0,15}$/;
const DEFAULT_ACCOUNT_LABEL = 'Telegram live test account';
const CONNECTOR_DISPLAY_NAME = 'Telegram live connector';
const ENV_FILE = '.env';
const USAGE = 'usage: npm run telegram:provision -- --owner-user-id <id> [--officer <id or display name>]... [--workspace <id>] [--label <text>]\n';

export interface ProvisionInput {
  /** The business owner's Telegram user ID: the live channel account's externalAccountId. */
  ownerUserId: string;
  /** Officer principal IDs or exact display names to grant on the live account. */
  officers: readonly string[];
  /** Required only when the database holds more than one workspace. */
  workspaceId?: string;
  label?: string;
}

export interface ProvisionResult {
  workspaceId: string;
  channelAccountId: string;
  accountCreated: boolean;
  principalId: string;
  /** The new connector's token; null when an existing connector was kept. */
  token: string | null;
  officerIds: string[];
}

function resolveWorkspace(tx: Tx, workspaceId: string | undefined): string {
  const workspaces = tx.all<WorkspaceRow>('SELECT * FROM workspaces ORDER BY created_at, id');
  if (workspaceId !== undefined) {
    if (!workspaces.some((w) => w.id === workspaceId)) throw new Error(`workspace not found: ${workspaceId}`);
    return workspaceId;
  }
  const [only] = workspaces;
  if (!only || workspaces.length > 1) {
    throw new Error(`expected exactly one workspace, found ${workspaces.length}; pass --workspace <id>`);
  }
  return only.id;
}

/** `position` (1-based) names the failing --officer argument without echoing a name. */
function resolveOfficer(tx: Tx, workspaceId: string, ref: string, position: number): string {
  const matches = tx.all<PrincipalRow>(
    `SELECT * FROM principals WHERE workspace_id = :workspaceId AND kind = 'officer' AND disabled = 0
     AND (id = :ref OR display_name = :ref)`,
    { workspaceId, ref },
  );
  const [match] = matches;
  if (!match || matches.length > 1) throw new Error(`--officer #${position} matches no officer, or more than one, in the workspace`);
  return match.id;
}

/** The connector serves exactly one owner account, so a live connector bound to another account is refused. */
function existingConnector(tx: Tx, accountId: string): string | null {
  const bindings = findLiveBindings(tx);
  const other = bindings.find((b) => b.account.id !== accountId);
  if (other) throw new Error(`a live connector is already provisioned for another owner account (${other.account.id})`);
  return bindings[0]?.principal.id ?? null;
}

/** One transaction: account, connector principal (unless one is already bound to the account) and grants. */
export function provisionLiveConnector(db: Db, input: ProvisionInput): ProvisionResult {
  if (!TELEGRAM_USER_ID.test(input.ownerUserId)) throw new Error('the owner user ID must be a Telegram user ID (digits only)');
  return db.transaction((tx) => {
    const workspaceId = resolveWorkspace(tx, input.workspaceId);
    const existingAccount = findChannelAccount(tx, workspaceId, 'telegram', input.ownerUserId);
    const account =
      existingAccount ??
      insertChannelAccount(tx, {
        workspaceId,
        source: 'telegram',
        externalAccountId: input.ownerUserId,
        label: input.label ?? DEFAULT_ACCOUNT_LABEL,
        isIntake: false,
      });
    let principalId = existingConnector(tx, account.id);
    let token: string | null = null;
    if (!principalId) {
      const made = provisionPrincipal(tx, {
        workspaceId,
        kind: 'connector',
        displayName: CONNECTOR_DISPLAY_NAME,
        captureMethod: 'telegram_business_live',
        trustedStartMarker: false,
      });
      grantAccount(tx, made.principal.id, account.id);
      principalId = made.principal.id;
      token = made.token;
    }
    const officerIds = input.officers.map((ref, index) => resolveOfficer(tx, workspaceId, ref, index + 1));
    officerIds.forEach((id) => grantAccount(tx, id, account.id));
    return { workspaceId, channelAccountId: account.id, accountCreated: !existingAccount, principalId, token, officerIds };
  });
}

function writeCredentials(file: string, result: ProvisionResult, ownerUserId: string, token: string): void {
  const credentials = {
    workspaceId: result.workspaceId,
    channelAccountId: result.channelAccountId,
    externalAccountId: ownerUserId,
    principalId: result.principalId,
    captureMethod: 'telegram_business_live',
    token,
  };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE });
  fs.renameSync(temp, file);
}

function describe(result: ProvisionResult, ownerUserId: string, credentialsFile: string): string {
  const connector = result.token === null ? 'existing connector kept; its token is unchanged' : `new token written to ${credentialsFile}`;
  return [
    'Telegram live connector provisioned.',
    `workspace: ${result.workspaceId}`,
    `live channel account: ${result.channelAccountId} (owner user ID ${ownerUserId}, ${result.accountCreated ? 'created' : 'existing'})`,
    `connector principal: ${result.principalId} (telegram_business_live; ${connector})`,
    `officer grants: ${result.officerIds.length > 0 ? result.officerIds.join(', ') : 'none'}`,
    'Next: set the TELEGRAM_* values in .env, run npm run telegram:verify, then set TELEGRAM_LIVE_ENABLED=true (docs/telegram/setup.md).',
    '',
  ].join('\n');
}

export interface ProvisionRunOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  write: (text: string) => void;
}

/** Returns the exit code: 0 provisioned, 1 refused, 2 usage. */
export function runProvision(options: ProvisionRunOptions): number {
  let input: ProvisionInput;
  try {
    const { values } = parseArgs({
      args: options.argv,
      options: { 'owner-user-id': { type: 'string' }, officer: { type: 'string', multiple: true }, workspace: { type: 'string' }, label: { type: 'string' } },
      strict: true,
    });
    if (!values['owner-user-id']) throw new Error('missing --owner-user-id');
    input = { ownerUserId: values['owner-user-id'], officers: values.officer ?? [], workspaceId: values.workspace, label: values.label };
  } catch {
    options.write(USAGE);
    return 2;
  }
  try {
    const config = loadConfig(options.env);
    const db = openDatabase(path.join(config.dataDir, DATABASE_FILE));
    let result: ProvisionResult;
    try {
      result = provisionLiveConnector(db, input);
    } finally {
      db.close();
    }
    const credentialsFile = path.join(config.dataDir, LIVE_CREDENTIALS_FILE);
    if (result.token !== null) writeCredentials(credentialsFile, result, input.ownerUserId, result.token);
    options.write(describe(result, input.ownerUserId, credentialsFile));
    return 0;
  } catch (error) {
    // Configuration and provisioning errors carry IDs and variable names only, never a token.
    options.write(`provisioning refused: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    return 1;
  }
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
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  process.exitCode = runProvision({ argv: process.argv.slice(2), env: process.env, write: (text) => process.stdout.write(text) });
}
