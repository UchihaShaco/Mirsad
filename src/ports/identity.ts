import type { ConnectorCaptureMethod, PrincipalKind } from '../contract/enums.ts';

/** An authenticated caller: an officer or an ingestion connector (design section 3). */
export interface Principal {
  id: string;
  kind: PrincipalKind;
  displayName: string;
  workspaceId: string;
  /** Fixed at provisioning for connectors; null for officers. */
  captureMethod: ConnectorCaptureMethod | null;
  trustedStartMarker: boolean;
}

export interface IdentityProvider {
  /** Maps the raw Authorization header to a principal, or null when missing, unknown or disabled. */
  authenticate(header: string | undefined): Principal | null;
}
