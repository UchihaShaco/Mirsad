import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../../src/config.ts';

describe('loadConfig', () => {
  it('accepts only a short, unexpired wording-test window', () => {
    const now = Date.now();
    const end = new Date(now + 5 * 60_000).toISOString();
    const window = (value: string) => loadConfig({ MIRSAD_TEST_WORDING_UNTIL: value }).telegram.aiReplies.wordingUntilMs;
    expect(window(end)).toBe(Date.parse(end));
    for (const value of ['', 'invalid', new Date(now - 1000).toISOString(), new Date(now + 20 * 60_000).toISOString()]) {
      expect(window(value)).toBeUndefined();
    }
  });
  it('loadConfig rejects a non-loopback MIRSAD_HOST and a non-loopback LM Studio URL', () => {
    expect(() => loadConfig({ MIRSAD_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ MIRSAD_HOST: '0.0.0.0' })).toThrow(/MIRSAD_HOST/);
    expect(() => loadConfig({ MIRSAD_HOST: '192.168.1.10' })).toThrow(/MIRSAD_HOST/);
    expect(() => loadConfig({ MIRSAD_LMSTUDIO_BASE_URL: 'http://lmstudio.example.test:1234/v1' })).toThrow(
      /MIRSAD_LMSTUDIO_BASE_URL/,
    );
    expect(() => loadConfig({ MIRSAD_LMSTUDIO_BASE_URL: 'not a url' })).toThrow(/MIRSAD_LMSTUDIO_BASE_URL/);
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(loadConfig({ MIRSAD_HOST: host }).host).toBe(host);
    }
    expect(loadConfig({ MIRSAD_LMSTUDIO_BASE_URL: 'http://localhost:4321/v1' }).lmStudio.baseUrl).toBe(
      'http://localhost:4321/v1',
    );
  });

  it('loadConfig applies the documented defaults', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      host: '127.0.0.1',
      port: 8787,
      dataDir: path.resolve('./data'),
      demoSeed: true,
      reviewer: 'lmstudio',
      replyProvider: { kind: 'lmstudio' },
      lmStudio: {
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'qwen3.5-9b',
        contextTokens: 4096,
        timeoutMs: 120_000,
      },
      reviewConcurrency: 2,
      reviewAllowedCaptureMethods: ['fixture_replay'],
      streamRetention: 5000,
      rateLimitPerMinute: 600,
      controlledTestRecordPath: fileURLToPath(
        new URL('../../docs/telegram/controlled-test-record.json', import.meta.url),
      ),
      telegram: {
        liveEnabled: false,
        botToken: null,
        approvedConnectionId: null,
        chatScope: 'approved',
        approvedChatIds: [],
        allChatsReference: null,
        excludedChatIds: [],
        approvalReference: null,
        aiReplies: { enabled: false, consentReference: null, autoStart: false },
      },
    });
  });

  it('keeps a configured Arabic reply model local and gives it its own context budget', () => {
    expect(loadConfig({
      MIRSAD_LMSTUDIO_ARABIC_MODEL: 'arabic-test',
      MIRSAD_LMSTUDIO_ARABIC_CONTEXT_TOKENS: '2048',
    }).lmStudio.arabicReply).toEqual({
      model: 'arabic-test', baseUrl: 'http://127.0.0.1:1234/v1', contextTokens: 2048,
    });
    expect(() => loadConfig({
      MIRSAD_LMSTUDIO_ARABIC_MODEL: 'arabic-test',
      MIRSAD_LMSTUDIO_ARABIC_BASE_URL: 'https://models.example.test/v1',
    })).toThrow(/MIRSAD_LMSTUDIO_ARABIC_BASE_URL/);
  });

  it('uses the OpenRouter credential only when the Telegram reply provider was explicitly selected', () => {
    const key = 'test-provider-key';
    expect(loadConfig({ OPENROUTER_API_KEY: key }).replyProvider).toEqual({ kind: 'lmstudio' });
    const env = { MIRSAD_REPLY_PROVIDER: 'openrouter', OPENROUTER_API_KEY: key, MIRSAD_LMSTUDIO_ARABIC_MODEL: 'local-arabic' };
    expect(loadConfig(env).replyProvider).toEqual({ kind: 'openrouter', apiKey: key, model: 'google/gemini-3.8-flash' });
    expect(loadConfig(env).reviewer).toBe('lmstudio');
    expect(loadConfig({ MIRSAD_REPLY_PROVIDER: 'openrouter' }).replyProvider).toEqual({
      kind: 'openrouter', apiKey: '', model: 'google/gemini-3.8-flash',
    });
    expect(() => loadConfig({ MIRSAD_REPLY_PROVIDER: 'other' })).toThrow(/MIRSAD_REPLY_PROVIDER/);
  });

  it('only accepts allowlisted model IDs on the selected OpenRouter provider', () => {
    const env = { MIRSAD_REPLY_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-key' };
    for (const model of ['google/gemini-3.8-flash', 'thedrummer/cydonia-24b-v4.1']) {
      expect(loadConfig({ ...env, MIRSAD_OPENROUTER_MODEL: model }).replyProvider).toEqual({
        kind: 'openrouter', apiKey: 'test-key', model,
      });
    }
    expect(() => loadConfig({ ...env, MIRSAD_OPENROUTER_MODEL: 'openrouter/auto' })).toThrow(/MIRSAD_OPENROUTER_MODEL/);
    expect(loadConfig({ MIRSAD_OPENROUTER_MODEL: 'openrouter/auto' }).replyProvider).toEqual({ kind: 'lmstudio' });
  });

  it('loadConfig parses explicit values and rejects malformed ones by variable name', () => {
    const config = loadConfig({
      MIRSAD_PORT: '0',
      MIRSAD_DEMO_SEED: 'false',
      MIRSAD_REVIEWER: 'deterministic',
      MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS: 'fixture_replay, approved_import',
      TELEGRAM_APPROVED_CHAT_IDS: '101, 102',
      TELEGRAM_CHAT_SCOPE: 'all_private',
      TELEGRAM_ALL_CHATS_REFERENCE: ' TEST-ALL-CHATS-01 ',
      TELEGRAM_EXCLUDED_CHAT_IDS: '201,202',
      TELEGRAM_AI_AUTO_START: 'true',
    });
    expect(config.port).toBe(0);
    expect(config.demoSeed).toBe(false);
    expect(config.reviewer).toBe('deterministic');
    expect(config.reviewAllowedCaptureMethods).toEqual(['fixture_replay', 'approved_import']);
    expect(config.telegram.approvedChatIds).toEqual(['101', '102']);
    expect(config.telegram).toMatchObject({ chatScope: 'all_private', allChatsReference: 'TEST-ALL-CHATS-01', excludedChatIds: ['201', '202'] });
    expect(config.telegram.aiReplies.autoStart).toBe(true);
    expect(() => loadConfig({ TELEGRAM_CHAT_SCOPE: 'everything' })).toThrow(/TELEGRAM_CHAT_SCOPE/);
    expect(() => loadConfig({ TELEGRAM_AI_AUTO_START: 'yes' })).toThrow(/TELEGRAM_AI_AUTO_START/);
    expect(() => loadConfig({ MIRSAD_PORT: '70000' })).toThrow(/MIRSAD_PORT/);
    expect(() => loadConfig({ MIRSAD_REVIEWER: 'cloud' })).toThrow(/MIRSAD_REVIEWER/);
    expect(() => loadConfig({ MIRSAD_DEMO_SEED: 'yes' })).toThrow(/MIRSAD_DEMO_SEED/);
    expect(() => loadConfig({ MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS: 'telegram_business_live' })).toThrow(
      /MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS/,
    );
  });

  it('loadConfig defaults the reviewer to lmstudio and the model to qwen3.5-9b', () => {
    const config = loadConfig({});
    expect(config.reviewer).toBe('lmstudio');
    expect(config.lmStudio.model).toBe('qwen3.5-9b');
  });

  it('loadConfig rejects an LM Studio URL whose hostname only starts with a loopback name', () => {
    for (const url of [
      'http://127.0.0.1.example.test/v1',
      'http://localhost.example.test:1234/v1',
      'http://127.0.0.1@lmstudio.example.test/v1',
    ]) {
      expect(() => loadConfig({ MIRSAD_LMSTUDIO_BASE_URL: url }), url).toThrow(/MIRSAD_LMSTUDIO_BASE_URL/);
    }
    expect(loadConfig({ MIRSAD_LMSTUDIO_BASE_URL: 'http://[::1]:1234/v1' }).lmStudio.baseUrl).toBe(
      'http://[::1]:1234/v1',
    );
  });
});
