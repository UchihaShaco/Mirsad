/** Workspaces, principals, channel accounts and account grants (design section 3). */
import type { ConnectorCaptureMethod, PrincipalKind, Source } from '../../contract/enums.ts';
import type { Principal } from '../../ports/identity.ts';
import type { Tx } from '../db.ts';
import { newId } from '../ids.ts';
import type { ChannelAccountRow, PrincipalRow, WorkspaceRow } from '../rows.ts';

export function insertWorkspace(tx: Tx, input: { name: string }): WorkspaceRow {
  const row = tx.get<WorkspaceRow>(
    'INSERT INTO workspaces (id, name, created_at) VALUES (:id, :name, :at) RETURNING *',
    { id: newId('ws'), name: input.name, at: tx.now() },
  );
  if (!row) throw new Error('workspace_insert_failed');
  return row;
}

export function countWorkspaces(tx: Tx): number {
  return tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces')?.n ?? 0;
}

export interface InsertPrincipalInput {
  workspaceId: string;
  kind: PrincipalKind;
  displayName: string;
  tokenSha256: string;
  captureMethod?: ConnectorCaptureMethod | null;
  trustedStartMarker?: boolean;
}

export function insertPrincipal(tx: Tx, input: InsertPrincipalInput): PrincipalRow {
  const row = tx.get<PrincipalRow>(
    `INSERT INTO principals (id, workspace_id, kind, display_name, token_sha256, capture_method, trusted_start_marker, created_at)
     VALUES (:id, :workspaceId, :kind, :displayName, :tokenSha256, :captureMethod, :trusted, :at) RETURNING *`,
    {
      id: newId('prn'),
      workspaceId: input.workspaceId,
      kind: input.kind,
      displayName: input.displayName,
      tokenSha256: input.tokenSha256,
      captureMethod: input.kind === 'connector' ? (input.captureMethod ?? null) : null,
      trusted: input.trustedStartMarker ?? false,
      at: tx.now(),
    },
  );
  if (!row) throw new Error('principal_insert_failed');
  return row;
}

export function findPrincipalByTokenHash(tx: Tx, tokenSha256: string): PrincipalRow | undefined {
  return tx.get<PrincipalRow>('SELECT * FROM principals WHERE token_sha256 = :hash', { hash: tokenSha256 });
}

export function findPrincipalById(tx: Tx, id: string): PrincipalRow | undefined {
  return tx.get<PrincipalRow>('SELECT * FROM principals WHERE id = :id', { id });
}

export function toPrincipal(row: PrincipalRow): Principal {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    workspaceId: row.workspace_id,
    captureMethod: row.kind === 'connector' ? (row.capture_method as ConnectorCaptureMethod | null) : null,
    trustedStartMarker: row.trusted_start_marker === 1,
  };
}

export interface InsertChannelAccountInput {
  workspaceId: string;
  source: Source;
  externalAccountId: string;
  label: string;
  isIntake: boolean;
}

export function insertChannelAccount(tx: Tx, input: InsertChannelAccountInput): ChannelAccountRow {
  const row = tx.get<ChannelAccountRow>(
    `INSERT INTO channel_accounts (id, workspace_id, source, external_account_id, label, is_intake, created_at)
     VALUES (:id, :workspaceId, :source, :externalAccountId, :label, :isIntake, :at) RETURNING *`,
    { id: newId('acct'), ...input, at: tx.now() },
  );
  if (!row) throw new Error('channel_account_insert_failed');
  return row;
}

export function findChannelAccount(
  tx: Tx,
  workspaceId: string,
  source: Source,
  externalAccountId: string,
): ChannelAccountRow | undefined {
  return tx.get<ChannelAccountRow>(
    `SELECT * FROM channel_accounts
     WHERE workspace_id = :workspaceId AND source = :source AND external_account_id = :externalAccountId`,
    { workspaceId, source, externalAccountId },
  );
}

export function findChannelAccountById(tx: Tx, id: string): ChannelAccountRow | undefined {
  return tx.get<ChannelAccountRow>('SELECT * FROM channel_accounts WHERE id = :id', { id });
}

export function grantAccount(tx: Tx, principalId: string, channelAccountId: string): void {
  tx.run(
    `INSERT INTO account_grants (principal_id, channel_account_id) VALUES (:principalId, :channelAccountId)
     ON CONFLICT DO NOTHING`,
    { principalId, channelAccountId },
  );
}

export function hasGrant(tx: Tx, principalId: string, channelAccountId: string): boolean {
  const row = tx.get<{ one: number }>(
    'SELECT 1 AS one FROM account_grants WHERE principal_id = :principalId AND channel_account_id = :channelAccountId',
    { principalId, channelAccountId },
  );
  return row !== undefined;
}

/** A disabled live connector still reserves its account's evidence provenance. */
export function hasTelegramLiveConnector(tx: Tx, channelAccountId: string): boolean {
  return tx.get(
    `SELECT 1 FROM account_grants g JOIN principals p ON g.principal_id = p.id
     WHERE g.channel_account_id = :channelAccountId AND p.kind = 'connector' AND p.capture_method = 'telegram_business_live' LIMIT 1`,
    { channelAccountId },
  ) !== undefined;
}

/** IDs of the channel accounts a principal holds a grant on. */
export function grantedAccountIds(tx: Tx, principalId: string): string[] {
  return tx
    .all<{ channel_account_id: string }>(
      'SELECT channel_account_id FROM account_grants WHERE principal_id = :principalId ORDER BY channel_account_id',
      { principalId },
    )
    .map((r) => r.channel_account_id);
}
