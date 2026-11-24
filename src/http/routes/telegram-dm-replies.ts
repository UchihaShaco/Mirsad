import { findLiveBindings } from '../../adapters/telegram/live-connector.ts';
import type { AppDeps } from '../../app.ts';
import { AppError, ok } from '../../contract/errors.ts';
import { ConsentPromptRequest, DmRepliesRequest } from '../../contract/schemas.ts';
import type { Principal } from '../../ports/identity.ts';
import { AliPromptReloadError, reloadAliPrompt } from '../../replies/ali-prompt.ts';
import {
  dmPolicyKey, dmPolicyMode, readDmPolicy, setDmPolicy, readConsentPromptPolicy, setConsentPromptPolicy,
} from '../../services/telegram-dm-policy.ts';
import type { Tx } from '../../storage/db.ts';
import { hasGrant } from '../../storage/repos/principals.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { requireSameOrigin } from '../middleware/host-guard.ts';
import { parseJsonBody } from '../middleware/validate.ts';

function bindingForOfficer(tx: Tx, officer: Principal) {
  const bindings = findLiveBindings(tx);
  const binding = bindings.length === 1 ? bindings[0] : undefined;
  return binding && binding.account.workspace_id === officer.workspaceId && hasGrant(tx, officer.id, binding.account.id)
    ? binding : undefined;
}

function dmReplies(tx: Tx, deps: AppDeps, officer: Principal, enabled?: boolean) {
  const binding = bindingForOfficer(tx, officer);
  if (!binding) {
    if (enabled !== undefined) throw AppError.of('account_not_found', 'Linked account not found.');
    return { enabled: false, available: false, mode: 'off' };
  }
  const { telegram } = deps.config;
  const available = telegram.chatScope === 'all_private' && deps.telegramLive.running() && deps.telegramLive.repliesRunning();
  const key = dmPolicyKey(binding.account.id, telegram.approvedConnectionId);
  if (enabled === true && !available) throw AppError.of('invalid_transition', 'All-private intake and automated replies must be running.');
  const policy = enabled === undefined ? readDmPolicy(tx, binding.principal.id, key)
    : setDmPolicy(tx, binding.principal.id, key, officer.workspaceId, officer.id, enabled);
  const mode = dmPolicyMode(policy, telegram);
  return { enabled: mode === 'all_private', available, mode };
}

function consentPrompt(tx: Tx, deps: AppDeps, officer: Principal, enabled?: boolean, manualDispatchOnly?: true) {
  const binding = bindingForOfficer(tx, officer);
  const connection = deps.config.telegram.approvedConnectionId;
  if (!binding || !connection) {
    if (enabled !== undefined) throw AppError.of('account_not_found', 'Linked account not found.');
    return { enabled: false, available: false };
  }
  const key = dmPolicyKey(binding.account.id, connection);
  const policy = enabled === undefined ? readConsentPromptPolicy(tx, binding.principal.id, key)
    : setConsentPromptPolicy(tx, binding.principal.id, key, officer.workspaceId, officer.id, enabled, manualDispatchOnly);
  return { enabled: policy.enabled, available: true, ...(policy.manualDispatchOnly && { manualDispatchOnly: true }) };
}

export const routes: RouteModule = {
  'POST /v1/telegram/reply-prompt/reload': async (c, deps) => {
    c.header('Cache-Control', 'no-store');
    requireSameOrigin(c);
    if (await c.req.text()) throw AppError.of('validation_failed', 'This action takes no request body.');
    if (!deps.config.telegram.approvedConnectionId || !deps.db.transaction(tx => bindingForOfficer(tx, principalOf(c)))) {
      throw AppError.of('account_not_found', 'Linked account not found.');
    }
    try {
      return c.json(ok(reloadAliPrompt()));
    } catch (error) {
      if (!(error instanceof AliPromptReloadError)) throw error;
      throw AppError.of('reply_prompt_unavailable', 'The saved prompt could not be loaded. The previous prompt is still active.');
    }
  },
  'GET /v1/telegram/dm-replies': (c, deps) => {
    c.header('Cache-Control', 'no-store');
    return c.json(ok(deps.db.transaction(tx => dmReplies(tx, deps, principalOf(c)))));
  },
  'POST /v1/telegram/dm-replies': async (c, deps) => {
    const { enabled } = await parseJsonBody(c, DmRepliesRequest);
    const result = deps.db.transaction(tx => dmReplies(tx, deps, principalOf(c), enabled));
    deps.workers.review.wake();
    c.header('Cache-Control', 'no-store');
    return c.json(ok(result));
  },
  'GET /v1/telegram/consent-prompt': (c, deps) => {
    c.header('Cache-Control', 'no-store');
    return c.json(ok(deps.db.transaction(tx => consentPrompt(tx, deps, principalOf(c)))));
  },
  'POST /v1/telegram/consent-prompt': async (c, deps) => {
    const body = await parseJsonBody(c, ConsentPromptRequest);
    const result = deps.db.transaction(tx => consentPrompt(tx, deps, principalOf(c), body.enabled, body.enabled ? body.manualDispatchOnly : undefined));
    deps.workers.review.wake();
    c.header('Cache-Control', 'no-store');
    return c.json(ok(result));
  },
};
