/** Creates workspaces and principals with fresh tokens; used by the demo seed, tests and provisioning scripts. */
import type { ConnectorCaptureMethod, PrincipalKind } from '../contract/enums.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { insertPrincipal, insertWorkspace, toPrincipal } from '../storage/repos/principals.ts';
import type { WorkspaceRow } from '../storage/rows.ts';
import { generateToken, hashToken } from './tokens.ts';

export function provisionWorkspace(tx: Tx, input: { name: string }): WorkspaceRow {
  return insertWorkspace(tx, input);
}

export interface ProvisionPrincipalInput {
  workspaceId: string;
  kind: PrincipalKind;
  displayName: string;
  captureMethod?: ConnectorCaptureMethod;
  trustedStartMarker?: boolean;
}

/** Inserts a principal and returns it with its token. The token is not stored; only its hash is. */
export function provisionPrincipal(tx: Tx, input: ProvisionPrincipalInput): { principal: Principal; token: string } {
  if (input.kind === 'connector' && input.captureMethod === undefined) {
    throw new Error('connector_capture_method_required');
  }
  const token = generateToken(input.kind);
  const row = insertPrincipal(tx, { ...input, tokenSha256: hashToken(token) });
  return { principal: toPrincipal(row), token };
}
