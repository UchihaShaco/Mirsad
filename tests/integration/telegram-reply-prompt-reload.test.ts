import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { provisionPrincipal } from '../../src/identity/provision.ts';
import { AliPromptReloadError } from '../../src/replies/ali-prompt.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { Harness, LIVE_BASE_ENV, standIns } from '../helpers/telegram-live-harness.ts';

const reload = vi.hoisted(() => vi.fn<() => { version: string; changed: boolean }>());
vi.mock('../../src/replies/ali-prompt.ts', async (original) => ({
  ...await original<typeof import('../../src/replies/ali-prompt.ts')>(), reloadAliPrompt: reload,
}));

const route = '/v1/telegram/reply-prompt/reload';
let h: Harness;
beforeEach(async () => {
  reload.mockReset();
  h = await Harness.start({ ...LIVE_BASE_ENV, TELEGRAM_LIVE_ENABLED: 'false', TELEGRAM_AI_REPLIES_ENABLED: 'false' }, standIns());
});
afterEach(async () => { await h.stop(); });

it('lets the assigned officer reload the saved prompt with the connector offline and returns only version metadata', async () => {
  reload.mockReturnValueOnce({ version: 'deca0badf00d', changed: true })
    .mockReturnValueOnce({ version: 'deca0badf00d', changed: false });
  const response = await fetch(h.url + route, {
    method: 'POST', headers: { origin: h.url, authorization: 'Bearer ' + h.data.token },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ success: true, data: { version: 'deca0badf00d', changed: true }, error: null });
  expect((await h.call('POST', route)).data).toEqual({ version: 'deca0badf00d', changed: false });
  expect(reload).toHaveBeenCalledTimes(2);
  expect(h.stand.sender.sent).toHaveLength(0);
});

it('checks authentication, linked-account access, browser origin and body before reading a prompt', async () => {
  const db = openDatabase(path.join(h.data.dataDir, DATABASE_FILE));
  const accounts = db.transaction(tx => {
    const workspaceId = tx.get<{ id: string }>('SELECT id FROM workspaces LIMIT 1')!.id;
    return {
      unassigned: provisionPrincipal(tx, { workspaceId, kind: 'officer', displayName: 'Unassigned test officer' }).token,
      connector: provisionPrincipal(tx, { workspaceId, kind: 'connector', displayName: 'Test connector', captureMethod: 'fixture_replay' }).token,
    };
  });
  db.close();
  expect((await h.call('POST', route, undefined, { authorization: '' })).error.code).toBe('unauthenticated');
  expect((await h.call('POST', route, undefined, { authorization: 'Bearer ' + accounts.connector })).error.code).toBe('forbidden_for_principal');
  expect((await h.call('POST', route, undefined, { authorization: 'Bearer ' + accounts.unassigned })).error.code).toBe('account_not_found');
  expect((await h.call('POST', route, undefined, { origin: 'https://example.invalid' })).error.code).toBe('origin_not_allowed');
  expect((await h.call('POST', route, { path: 'other-prompt.md' })).error.code).toBe('validation_failed');
  expect(reload).not.toHaveBeenCalled();
});

it.each(['invalid', 'unreadable'] as const)('reports a safe error when the saved prompt is %s', async reason => {
  reload.mockImplementationOnce(() => { throw new AliPromptReloadError(reason); });
  const response = await fetch(h.url + route, { method: 'POST', headers: { authorization: 'Bearer ' + h.data.token } });
  expect(response.status).toBe(422);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    success: false, data: null, error: {
      code: 'reply_prompt_unavailable', message: 'The saved prompt could not be loaded. The previous prompt is still active.',
    },
  });
});
