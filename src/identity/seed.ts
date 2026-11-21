/**
 * Demo seed (design section 15): on an empty database, one workspace, two officers, two Telegram fixture
 * accounts and one fixture connector. Tokens are written once to <dataDir>/demo-credentials.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db, Tx } from '../storage/db.ts';
import { countWorkspaces, grantAccount, insertChannelAccount } from '../storage/repos/principals.ts';
import { provisionPrincipal, provisionWorkspace } from './provision.ts';

export const DEMO_CREDENTIALS_FILE = 'demo-credentials.json';
const CREDENTIALS_FILE_MODE = 0o600;

export const DEMO_ACCOUNTS = {
  intake: { source: 'telegram', externalAccountId: 'tg-demo-intake', label: 'Demo intake account', isIntake: true },
  officer: { source: 'telegram', externalAccountId: 'tg-demo-officer', label: 'Demo officer account', isIntake: false },
} as const;

interface CredentialEntry {
  id: string;
  displayName: string;
  token: string;
}

export interface DemoCredentials {
  workspaceId: string;
  officers: CredentialEntry[];
  connector: CredentialEntry & { captureMethod: 'fixture_replay' };
  accounts: { source: 'telegram'; externalAccountId: string; isIntake: boolean }[];
}

export type SeedResult = { created: true; credentials: DemoCredentials; file: string } | { created: false };

function seedRows(tx: Tx): DemoCredentials {
  const workspace = provisionWorkspace(tx, { name: 'Demo workspace' });
  const accounts = [DEMO_ACCOUNTS.intake, DEMO_ACCOUNTS.officer].map((a) =>
    insertChannelAccount(tx, { workspaceId: workspace.id, ...a }),
  );
  const grantAll = (principalId: string) => accounts.forEach((a) => grantAccount(tx, principalId, a.id));
  const officers = ['Demo Officer 1', 'Demo Officer 2'].map((displayName) => {
    const made = provisionPrincipal(tx, { workspaceId: workspace.id, kind: 'officer', displayName });
    grantAll(made.principal.id);
    return { id: made.principal.id, displayName, token: made.token };
  });
  const connector = provisionPrincipal(tx, {
    workspaceId: workspace.id,
    kind: 'connector',
    displayName: 'Demo fixture connector',
    captureMethod: 'fixture_replay',
    trustedStartMarker: true,
  });
  grantAll(connector.principal.id);
  return {
    workspaceId: workspace.id,
    officers,
    connector: {
      id: connector.principal.id,
      displayName: connector.principal.displayName,
      token: connector.token,
      captureMethod: 'fixture_replay',
    },
    accounts: accounts.map((a) => ({ source: 'telegram', externalAccountId: a.external_account_id, isIntake: a.is_intake === 1 })),
  };
}

function writeCredentials(file: string, credentials: DemoCredentials): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE });
  fs.renameSync(temp, file);
}

/** Seeds only when the database holds no workspace; otherwise does nothing. */
export function seedDemo(db: Db, options: { dataDir: string }): SeedResult {
  const credentials = db.transaction((tx) => (countWorkspaces(tx) === 0 ? seedRows(tx) : null));
  if (!credentials) return { created: false };
  const file = path.join(options.dataDir, DEMO_CREDENTIALS_FILE);
  writeCredentials(file, credentials);
  return { created: true, credentials, file };
}
