import { AppError, ok } from '../../contract/errors.ts';
import { OfficerLoginRequest } from '../../contract/schemas.ts';
import { loginOfficer, logoutOfficer, OfficerProvisionError } from '../../identity/officer-password.ts';
import { parseBearer } from '../../identity/tokens.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { requireSameOrigin } from '../middleware/host-guard.ts';
import { parseJsonBody } from '../middleware/validate.ts';

const MAX_PASSWORD_CHECKS = 2;
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 60_000;

/** A single budget per app prevents caller-chosen usernames, tokens and forwarding headers from splitting it. */
export function createAuthRoutes(): RouteModule {
  let attempts: number[] = [];
  let active = 0;
  return {
    'POST /v1/auth/login': async (c, deps) => {
      requireSameOrigin(c);
      if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        throw AppError.of('validation_failed', 'The login request must use application/json.');
      }
      const credentials = await parseJsonBody(c, OfficerLoginRequest).catch(() => {
        // Zod issues can quote user-supplied extra keys. Never return credential input in an error.
        throw AppError.of('validation_failed', 'Supply a username and password.');
      });
      const now = deps.clock.now().getTime();
      attempts = attempts.filter(at => at > now - LOGIN_WINDOW_MS);
      if (attempts.length >= MAX_LOGIN_ATTEMPTS || active >= MAX_PASSWORD_CHECKS) {
        throw AppError.of('rate_limited', 'Too many login attempts. Try again shortly.');
      }
      attempts.push(now);
      active++;
      try {
        const result = await loginOfficer(deps.db, credentials.username, credentials.password, credentials.newPassword);
        if (!result) throw AppError.of('unauthenticated', 'Invalid username or password.');
        return c.json(ok(result));
      } catch (error) {
        if (error instanceof OfficerProvisionError && error.code === 'invalid_password') {
          throw AppError.of('validation_failed', 'Choose a different password with 12–128 characters.');
        }
        throw error;
      } finally {
        active--;
      }
    },
    'POST /v1/auth/logout': (c, deps) => {
      requireSameOrigin(c);
      const token = parseBearer(c.req.header('authorization'));
      if (!token?.startsWith('session_')) throw AppError.of('forbidden_for_principal', 'A dashboard session is required.');
      logoutOfficer(deps.db, token);
      deps.bus.notify(principalOf(c).workspaceId);
      return c.json(ok({ loggedOut: true }));
    },
  };
}
