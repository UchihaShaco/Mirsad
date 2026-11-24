/**
 * Which Telegram chats Mirsad stores and answers (src/adapters/telegram/chat-scope.ts), the live gates each scope needs
 * (missingLiveGates) and the setup check that reports the scope (verifyConnection). All IDs are synthetic.
 */
import { describe, expect, it } from 'vitest';
import type { BotApi } from '../../src/adapters/telegram/bot-api.ts';
import { chatScopeOf, isChatInScope, TELEGRAM_SERVICE_CHAT_ID } from '../../src/adapters/telegram/chat-scope.ts';
import { LIVE_GATES, missingLiveGates } from '../../src/adapters/telegram/live-connector.ts';
import { verifyConnection } from '../../src/adapters/telegram/verify.ts';
import { loadConfig } from '../../src/config.ts';

const OWNER_ID = 5000000001;
const BOT_TOKEN = '5000000999:TEST_token_not_real_0123456789abcd';
const LIVE_ENV = {
  TELEGRAM_LIVE_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_APPROVED_CONNECTION_ID: 'TestBizConn-0101',
  TELEGRAM_APPROVAL_REFERENCE: 'TEST-APPROVAL-0001',
};

const scopeOf = (env: Record<string, string>) => chatScopeOf(loadConfig(env).telegram);

describe('chat scope', () => {
  it('approved: only the listed chats; an excluded chat and the service chat never, even when listed', () => {
    const scope = scopeOf({ TELEGRAM_APPROVED_CHAT_IDS: `6000000101,6000000102,${TELEGRAM_SERVICE_CHAT_ID}`, TELEGRAM_EXCLUDED_CHAT_IDS: '6000000102' });
    expect(isChatInScope(scope, '6000000101', OWNER_ID)).toBe(true);
    expect(isChatInScope(scope, '6000000102', OWNER_ID)).toBe(false);
    expect(isChatInScope(scope, '6000000103', OWNER_ID)).toBe(false);
    expect(isChatInScope(scope, TELEGRAM_SERVICE_CHAT_ID, OWNER_ID)).toBe(false);
  });

  it("all private: any private chat, but not an excluded one, Telegram's service chat, the owner's own chat or a group", () => {
    const scope = scopeOf({ TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_EXCLUDED_CHAT_IDS: '6000000102' });
    expect(isChatInScope(scope, '6000000101', OWNER_ID)).toBe(true);
    expect(isChatInScope(scope, '6000000999', OWNER_ID)).toBe(true);
    expect(isChatInScope(scope, '6000000102', OWNER_ID)).toBe(false);
    expect(isChatInScope(scope, TELEGRAM_SERVICE_CHAT_ID, OWNER_ID)).toBe(false);
    expect(isChatInScope(scope, String(OWNER_ID), OWNER_ID)).toBe(false);
    expect(isChatInScope(scope, '-1000000000301', OWNER_ID)).toBe(false);
    expect(isChatInScope(scope, '0', OWNER_ID)).toBe(false);
  });
});

describe('live gates per scope', () => {
  const gates = (env: Record<string, string>) => missingLiveGates(loadConfig({ ...LIVE_ENV, ...env }).telegram);

  it('approved needs a valid chat list; all private needs the owner-decision reference instead', () => {
    expect(gates({ TELEGRAM_APPROVED_CHAT_IDS: '6000000101' })).toEqual([]);
    expect(gates({})).toEqual([LIVE_GATES.chats]);
    expect(gates({ TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST-ALL-CHATS-0001' })).toEqual([]);
    expect(gates({ TELEGRAM_CHAT_SCOPE: 'all_private' })).toEqual([LIVE_GATES.allChats]);
  });

  it('refuses excluded chat IDs that are not chat IDs, in either scope', () => {
    expect(gates({ TELEGRAM_APPROVED_CHAT_IDS: '6000000101', TELEGRAM_EXCLUDED_CHAT_IDS: 'someone' })).toEqual([LIVE_GATES.excluded]);
    expect(gates({ TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'X', TELEGRAM_EXCLUDED_CHAT_IDS: '6000000102,-5' })).toEqual([]);
  });
});

describe('setup check for the chat scope', () => {
  const api: BotApi = {
    getMe: async () => ({ id: 5000000999, is_bot: true, first_name: 'Test Bot', username: 'mirsad_test_bot', can_connect_to_business: true }),
    getWebhookInfo: async () => ({ url: '', pending_update_count: 0 }),
    getBusinessConnection: async () => ({ id: 'TestBizConn-0101', user: { id: OWNER_ID, is_bot: false, first_name: 'Test' }, user_chat_id: OWNER_ID, date: 1790000000, is_enabled: true }),
    getUpdates: async () => [],
  };
  const chatsCheck = async (env: Record<string, string>) =>
    (await verifyConnection(api, loadConfig({ ...LIVE_ENV, ...env }), { provisionedOwnerUserId: String(OWNER_ID) })).checks.find(
      (c) => c.id === 'approved_chats_configured',
    );

  it.each([
    ['', true],
    ['777000,-123', false],
    [String(OWNER_ID), false],
    ['6000000102', false],
    ['6000000101,invalid', false],
    ['6000000101,6000000102', true],
  ])('checks an independent approved reply list under broad intake (%s)', async (ids, passed) => {
    const config = loadConfig({ ...LIVE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST',
      TELEGRAM_APPROVED_CHAT_IDS: String(ids), TELEGRAM_EXCLUDED_CHAT_IDS: '6000000102', TELEGRAM_AI_REPLIES_ENABLED: 'true' });
    const report = await verifyConnection(api, config, { provisionedOwnerUserId: String(OWNER_ID) });
    expect(report.checks.find((check) => check.id === 'ai_reply_chats_configured')?.passed).toBe(passed);
  });

  it('passes for all private chats with the reference, and says so', async () => {
    expect(await chatsCheck({ TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'X', TELEGRAM_EXCLUDED_CHAT_IDS: '6000000102' })).toMatchObject({
      passed: true,
      detail: 'all private chats (TELEGRAM_CHAT_SCOPE=all_private), 1 excluded',
    });
  });

  it('fails for all private chats without the reference, and for excluded IDs that are not chat IDs', async () => {
    expect(await chatsCheck({ TELEGRAM_CHAT_SCOPE: 'all_private' })).toMatchObject({ passed: false, detail: 'TELEGRAM_ALL_CHATS_REFERENCE is not set' });
    expect(await chatsCheck({ TELEGRAM_APPROVED_CHAT_IDS: '6000000101', TELEGRAM_EXCLUDED_CHAT_IDS: 'someone' })).toMatchObject({ passed: false });
    expect(await chatsCheck({ TELEGRAM_APPROVED_CHAT_IDS: '6000000101' })).toMatchObject({ passed: true, detail: '1 approved chat IDs' });
  });

  it.each(['06000000101', '-06000000101', '0', '-0', '9007199254740992', 'invalid'])(
    'refuses unusable chat ID %s at startup and verification',
    async (id) => {
      for (const [settings, failedGate] of [
        [{ TELEGRAM_APPROVED_CHAT_IDS: id }, LIVE_GATES.chats],
        [{ TELEGRAM_APPROVED_CHAT_IDS: '6000000102', TELEGRAM_EXCLUDED_CHAT_IDS: id }, LIVE_GATES.excluded],
        [{ TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST', TELEGRAM_EXCLUDED_CHAT_IDS: id }, LIVE_GATES.excluded],
      ] as const) {
        const telegram = loadConfig({ ...LIVE_ENV, ...settings }).telegram;
        expect.soft(missingLiveGates(telegram)).toEqual([failedGate]);
        const report = await verifyConnection(api, { telegram }, { provisionedOwnerUserId: String(OWNER_ID) });
        const scopeCheck = report.checks.find((check) => check.id === 'approved_chats_configured');
        expect.soft(scopeCheck?.passed).toBe(false);
        expect.soft(scopeCheck?.detail).toContain(failedGate);
      }
    },
  );
});
