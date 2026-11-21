import type { Db } from '../../src/storage/db.ts';
import type { Tx } from '../../src/storage/db.ts';
import { grantAccount, insertChannelAccount } from '../../src/storage/repos/principals.ts';
import { provisionPrincipal, provisionWorkspace } from '../../src/identity/provision.ts';

export interface TestTokens {
  officerA: string;
  officerB: string;
  officerC: string;
  outsider: string;
  connector: string;
  liveConnector: string;
}

export const TEST_ACCOUNTS = {
  intake: { source: 'telegram', externalAccountId: 'tg-intake-1' },
  officer: { source: 'telegram', externalAccountId: 'tg-officer-1' },
  live: { source: 'telegram', externalAccountId: 'tg-live-1' },
} as const;

function account(tx: Tx, workspaceId: string, externalAccountId: string, label: string, isIntake: boolean): string {
  return insertChannelAccount(tx, { workspaceId, source: 'telegram', externalAccountId, label, isIntake }).id;
}

/** Seeds the two workspaces, officers, connectors and accounts described in design section 17. */
export function seedTestData(db: Db): TestTokens {
  return db.transaction((tx) => {
    const wsA = provisionWorkspace(tx, { name: 'Test Workspace A' }).id;
    const wsB = provisionWorkspace(tx, { name: 'Test Workspace B' }).id;
    const intake = account(tx, wsA, TEST_ACCOUNTS.intake.externalAccountId, 'Test intake account', true);
    const officerAcct = account(tx, wsA, TEST_ACCOUNTS.officer.externalAccountId, 'Test officer account', false);
    const live = account(tx, wsA, TEST_ACCOUNTS.live.externalAccountId, 'Test live account', false);

    const officer = (displayName: string, workspaceId: string, grants: string[]) => {
      const made = provisionPrincipal(tx, { workspaceId, kind: 'officer', displayName });
      for (const id of grants) grantAccount(tx, made.principal.id, id);
      return made.token;
    };
    const connector = provisionPrincipal(tx, {
      workspaceId: wsA,
      kind: 'connector',
      displayName: 'Fixture Connector',
      captureMethod: 'fixture_replay',
      trustedStartMarker: true,
    });
    grantAccount(tx, connector.principal.id, intake);
    grantAccount(tx, connector.principal.id, officerAcct);
    const liveConnector = provisionPrincipal(tx, {
      workspaceId: wsA,
      kind: 'connector',
      displayName: 'Live Connector',
      captureMethod: 'telegram_business_live',
      trustedStartMarker: false,
    });
    grantAccount(tx, liveConnector.principal.id, live);

    return {
      officerA: officer('Officer A', wsA, [intake, officerAcct, live]),
      officerB: officer('Officer B', wsA, [intake, officerAcct, live]),
      officerC: officer('Officer C', wsA, [intake]),
      outsider: officer('Outside Officer', wsB, []),
      connector: connector.token,
      liveConnector: liveConnector.token,
    };
  });
}
