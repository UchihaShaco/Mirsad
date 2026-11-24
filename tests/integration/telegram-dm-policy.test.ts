import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { provisionPrincipal } from '../../src/identity/provision.ts';
import { openDatabase, DATABASE_FILE } from '../../src/storage/db.ts';
import { Harness, LIVE_BASE_ENV, standIns, WAIT } from '../helpers/telegram-live-harness.ts';

const listed = 6000000921;
const unlisted = 6000000922;
const env = { ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST',
  TELEGRAM_APPROVED_CHAT_IDS: String(listed) };
const route = '/v1/telegram/dm-replies';
const consentPrompt = '/v1/telegram/consent-prompt';

it('starts pre-approved DMs on new turns, cancels a pending draft on off, and retains the choice after restart', async () => {
  const first = standIns();
  let h = await Harness.start(env, first);
  try {
    expect((await h.call('GET', route)).data).toEqual({ available: true, enabled: false, mode: 'approved' });
    await h.receive(listed, 'Captured before switch');
    expect((await h.call('POST', consentPrompt, { enabled: false })).data.enabled).toBe(false);
    expect((await h.call('POST', route, { enabled: true })).data.mode).toBe('all_private');
    await h.app.drain();
    expect(first.generator.histories).toHaveLength(0);
    first.generator.holdNext();
    await h.receive(listed, 'Fresh turn after switch');
    await vi.waitFor(() => expect(first.generator.histories).toEqual([[{ from: 'contact', text: 'Fresh turn after switch' }]]), WAIT);
    expect((await h.call('POST', route, { enabled: false })).data.mode).toBe('off');
    await h.receive(unlisted, 'While off');
    expect((await h.call('POST', route, { enabled: true })).data.enabled).toBe(true);
    first.generator.releaseHeld();
    await h.app.drain();
    expect(first.sender.sent).toHaveLength(0);
    await h.receive(listed, 'After re-enable');
    await h.app.drain();
    expect(first.generator.histories.at(-1)).toEqual([{ from: 'contact', text: 'After re-enable' }]);
    expect(first.sender.to(listed)).toHaveLength(1);
    await h.close();
    const second = standIns(first.clock);
    h = await Harness.start(env, second, h.data);
    expect((await h.call('GET', route)).data.enabled).toBe(true);
    expect((await h.call('POST', route, { enabled: false })).data.mode).toBe('off');
    await h.close();
    h = await Harness.start(env, standIns(first.clock), h.data);
    expect((await h.call('GET', route)).data.mode).toBe('off');
    await h.receive(listed, 'Fresh after restart but turned off');
    await h.app.drain();
    expect(h.stand.sender.sent).toHaveLength(0);
  } finally {
    first.generator.releaseHeld();
    await h.stop();
  }
});

it('stops auto-dispatch when test mode is turned off and continues an already active authorized chat', async () => {
  const secondListed = 6000000923;
  const stand = standIns();
  const h = await Harness.start({ ...env, TELEGRAM_APPROVED_CHAT_IDS: [listed, secondListed].join(','),
    TELEGRAM_AI_AUTO_START: 'true' }, stand);
  try {
    expect((await h.call('POST', route, { enabled: true })).success).toBe(true);
    expect((await h.call('POST', consentPrompt, { enabled: false })).success).toBe(true);
    stand.generator.replyNext('How tall is the desk?');
    await h.receive(listed, 'I have a wooden desk for sale.');
    await h.app.drain();
    expect(stand.sender.to(listed)).toHaveLength(1);
    expect((await h.chatFor(listed))?.aiMode).toBe('ai_active');

    expect((await h.call('POST', consentPrompt, { enabled: true })).success).toBe(true);
    await h.receive(secondListed, 'Are you looking for a bookcase?');
    await h.app.drain();
    expect((await h.chatFor(secondListed))?.aiMode).toBe('not_started');
    expect(await h.caseActionsOf(secondListed, 'ai_auto_started')).toHaveLength(0);
    expect(stand.generator.histories).toHaveLength(1);
    expect(stand.sender.to(secondListed)).toHaveLength(0);

    stand.generator.replyNext('How wide is it?');
    await h.receive(listed, 'It is ninety centimetres tall.');
    await h.app.drain();
    expect(stand.sender.to(listed)).toHaveLength(2);
    expect(await h.caseActionsOf(listed, 'ai_auto_started')).toHaveLength(1);
  } finally { await h.stop(); }
});

it('keeps account controls private to an officer granted the linked account', async () => {
  const h = await Harness.start(env, standIns());
  try {
    const db = openDatabase(path.join(h.data.dataDir, DATABASE_FILE));
    const token = db.transaction(tx => provisionPrincipal(tx, {
      workspaceId: tx.get<{ id: string }>('SELECT id FROM workspaces LIMIT 1')!.id,
      kind: 'officer', displayName: 'Unassigned test officer',
    }).token);
    db.close();
    const headers = { authorization: 'Bearer ' + token };
    expect((await h.call('GET', route, undefined, headers)).data).toEqual({ available: false, enabled: false, mode: 'off' });
    expect((await h.call('POST', route, { enabled: true }, headers)).error.code).toBe('account_not_found');
    expect((await h.call('GET', consentPrompt, undefined, headers)).data).toEqual({ available: false, enabled: false });
    expect((await h.call('POST', consentPrompt, { enabled: false }, headers)).error.code).toBe('account_not_found');
    expect((await h.call('POST', consentPrompt, { enabled: 'false' })).error.code).toBe('validation_failed');
    expect((await h.call('GET', consentPrompt)).data).toEqual({ available: true, enabled: true });
    expect((await h.call('POST', route, { enabled: 'true' })).error.code).toBe('validation_failed');
    expect((await h.call('GET', route)).data.mode).toBe('approved');
  } finally { await h.stop(); }
});

it('stores the consent prompt separately per connection and lets the granted officer change it offline', async () => {
  const offline = { ...env, TELEGRAM_LIVE_ENABLED: 'false', TELEGRAM_AI_REPLIES_ENABLED: 'false' };
  let h = await Harness.start(offline, standIns());
  try {
    expect((await h.call('GET', consentPrompt)).data).toEqual({ enabled: true, available: true });
    expect((await h.call('POST', consentPrompt, { enabled: false })).data).toEqual({ enabled: false, available: true });
    const original = h.data;
    await h.close();
    h = await Harness.start({ ...offline, TELEGRAM_APPROVED_CONNECTION_ID: 'TEST-ANOTHER-CONNECTION' }, standIns(), original);
    expect((await h.call('GET', consentPrompt)).data.enabled).toBe(true);
    await h.close();
    h = await Harness.start(env, standIns(), original);
    expect((await h.call('GET', consentPrompt)).data.enabled).toBe(false);
    expect((await h.call('POST', route, { enabled: true })).data.mode).toBe('all_private');
    expect((await h.call('GET', consentPrompt)).data.enabled).toBe(false);
    expect((await h.call('POST', consentPrompt, { enabled: true })).data.enabled).toBe(true);
    expect((await h.call('GET', route)).data.mode).toBe('all_private');
  } finally { await h.stop(); }
});

it('restores the switch after an installation suspension without replaying captured text', async () => {
  const first = standIns();
  let h = await Harness.start(env, first);
  try {
    await h.call('POST', route, { enabled: true });
    await h.call('POST', consentPrompt, { enabled: false });
    await h.close();
    h = await Harness.start({ ...env, TELEGRAM_AI_REPLIES_ENABLED: 'false' }, standIns(first.clock), h.data);
    await h.receive(listed, 'Captured while the reply worker is disabled');
    await h.close();
    const restored = standIns(first.clock);
    h = await Harness.start(env, restored, h.data);
    expect((await h.call('GET', route)).data).toEqual({ enabled: true, available: true, mode: 'all_private' });
    await h.app.drain();
    expect(restored.generator.histories).toEqual([]);
    await h.receive(listed, 'First fresh message');
    await h.app.drain();
    expect(restored.generator.histories).toEqual([[{ from: 'contact', text: 'First fresh message' }]]);
  } finally { await h.stop(); }
});
