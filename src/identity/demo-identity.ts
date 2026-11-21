/** Demo identity adapter: bearer tokens looked up by SHA-256 (design section 3). A host replaces it. */
import type { IdentityProvider, Principal } from '../ports/identity.ts';
import type { Db } from '../storage/db.ts';
import { findPrincipalByTokenHash, toPrincipal } from '../storage/repos/principals.ts';
import { hashToken, parseBearer } from './tokens.ts';

export function createDemoIdentity(db: Db): IdentityProvider {
  return {
    authenticate(header: string | undefined): Principal | null {
      const token = parseBearer(header);
      if (token === null) return null;
      const row = db.transaction((tx) => findPrincipalByTokenHash(tx, hashToken(token)));
      if (!row || row.disabled === 1) return null;
      return toPrincipal(row);
    },
  };
}
