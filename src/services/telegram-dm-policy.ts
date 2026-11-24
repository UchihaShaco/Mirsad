import { createHash } from 'node:crypto';
import type { Config } from '../config.ts';
import type { Tx } from '../storage/db.ts';

export function dmPolicyKey(accountId: string, connectionId: string | null): string {
  const connection = createHash('sha256').update(connectionId ?? '').digest('hex');
  return 'telegram_private_dm_replies_v1:' + accountId + ':' + connection;
}

export interface DmPolicy {
  enabled: boolean;
  revision: number;
  position: number;
  second: number;
  officerId: string;
  suspended?: boolean;
  /** Applies to the consent-prompt preference when an officer selects manual Dispatch. */
  manualDispatchOnly?: true;
}

export function readDmPolicy(tx: Tx, connectorId: string, key: string): DmPolicy | null {
  const row = tx.get<{ value: string }>('SELECT value FROM connector_state WHERE connector_id=:connectorId AND key=:key',
    { connectorId, key });
  return row ? JSON.parse(row.value) as DmPolicy : null;
}

/** The enable boundary is shared by all future chats on this connection, including ones unknown today. */
export function setDmPolicy(tx: Tx, connectorId: string, key: string, workspaceId: string, officerId: string, enabled: boolean,
  manualDispatchOnly?: true): DmPolicy {
  const previous = readDmPolicy(tx, connectorId, key);
  if (previous?.enabled === enabled && previous.manualDispatchOnly === manualDispatchOnly) return previous;
  const workspace = tx.get<{ stream_seq: number }>('SELECT stream_seq FROM workspaces WHERE id=:id', { id: workspaceId })!;
  const now = tx.now();
  const policy: DmPolicy = { enabled, revision: (previous?.revision ?? 0) + 1, position: workspace.stream_seq,
    second: Math.ceil(Date.parse(now) / 1000), officerId, ...(manualDispatchOnly && { manualDispatchOnly }) };
  tx.run(`INSERT INTO connector_state(connector_id,key,value,updated_at) VALUES (:connectorId,:key,:value,:now)
    ON CONFLICT(connector_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    { connectorId, key, value: JSON.stringify(policy), now });
  return policy;
}

type ConsentPromptPolicy = Pick<DmPolicy, 'enabled' | 'revision' | 'position' | 'second' | 'manualDispatchOnly'>;

export function invitationsEnabled(policy: ConsentPromptPolicy | null): boolean {
  return policy?.enabled === true && !policy.manualDispatchOnly;
}

/** An invitation preference shares the account/connection identity, but has its own enable boundary. */
function consentPromptKey(accountPolicyKey: string): string {
  return 'telegram_consent_prompt_v1:' + accountPolicyKey;
}

export function readConsentPromptPolicy(tx: Tx, connectorId: string, accountPolicyKey: string): ConsentPromptPolicy {
  return readDmPolicy(tx, connectorId, consentPromptKey(accountPolicyKey)) ??
    { enabled: true, revision: 0, position: 0, second: 0 };
}

export function setConsentPromptPolicy(tx: Tx, connectorId: string, accountPolicyKey: string,
  workspaceId: string, officerId: string, enabled: boolean, manualDispatchOnly?: true): ConsentPromptPolicy {
  const current = readConsentPromptPolicy(tx, connectorId, accountPolicyKey);
  if (current.enabled === enabled && current.manualDispatchOnly === manualDispatchOnly) return current;
  return setDmPolicy(tx, connectorId, consentPromptKey(accountPolicyKey), workspaceId, officerId, enabled, manualDispatchOnly);
}

/** A stopped installation must not reply later to messages received while an installation gate was closed. */
export function suspendDmPolicies(tx: Tx): void {
  tx.run(`UPDATE connector_state SET value=json_set(value,'$.suspended',1), updated_at=:now
    WHERE key GLOB 'telegram_private_dm_replies_v1:*' AND json_extract(value,'$.enabled')=1`, { now: tx.now() });
}

export function reconcileDmPolicy(tx: Tx, connectorId: string, key: string, workspaceId: string, broadIntake: boolean): void {
  const previous = readDmPolicy(tx, connectorId, key);
  if (!previous?.enabled) return;
  if (!broadIntake) {
    tx.run("UPDATE connector_state SET value=json_set(value,'$.suspended',1),updated_at=:now WHERE connector_id=:connectorId AND key=:key",
      { now: tx.now(), connectorId, key });
  } else if (previous.suspended) {
    const position = tx.get<{ stream_seq: number }>('SELECT stream_seq FROM workspaces WHERE id=:id', { id: workspaceId })!.stream_seq;
    const now = tx.now();
    const policy: DmPolicy = { ...previous, suspended: false, revision: previous.revision + 1, position,
      second: Math.ceil(Date.parse(now) / 1000) };
    tx.run('UPDATE connector_state SET value=:value,updated_at=:now WHERE connector_id=:connectorId AND key=:key',
      { connectorId, key, now, value: JSON.stringify(policy) });
  }
}

/** Installation defaults keep the existing explicitly enrolled list until an officer chooses a runtime setting. */
export function dmPolicyMode(policy: DmPolicy | null, telegram: Config['telegram']): 'off' | 'approved' | 'all_private' {
  if (!policy) return 'approved';
  return policy.enabled && telegram.chatScope === 'all_private' && telegram.allChatsReference ? 'all_private' : 'off';
}
