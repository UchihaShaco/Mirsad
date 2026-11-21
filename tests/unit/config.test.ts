import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { ConfigError, loadConfig } from '../../src/config.ts';

describe('loadConfig', () => {
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
      whatsappImportEnabled: false,
      telegram: {
        liveEnabled: false,
        botToken: null,
        approvedConnectionId: null,
        approvedChatIds: [],
        approvalReference: null,
      },
    });
  });

  it('loadConfig parses explicit values and rejects malformed ones by variable name', () => {
    const config = loadConfig({
      MIRSAD_PORT: '0',
      MIRSAD_DEMO_SEED: 'false',
      MIRSAD_REVIEWER: 'deterministic',
      MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS: 'fixture_replay, approved_import',
      TELEGRAM_APPROVED_CHAT_IDS: '101, 102',
    });
    expect(config.port).toBe(0);
    expect(config.demoSeed).toBe(false);
    expect(config.reviewer).toBe('deterministic');
    expect(config.reviewAllowedCaptureMethods).toEqual(['fixture_replay', 'approved_import']);
    expect(config.telegram.approvedChatIds).toEqual(['101', '102']);
    expect(() => loadConfig({ MIRSAD_PORT: '70000' })).toThrow(/MIRSAD_PORT/);
    expect(() => loadConfig({ MIRSAD_REVIEWER: 'cloud' })).toThrow(/MIRSAD_REVIEWER/);
    expect(() => loadConfig({ MIRSAD_DEMO_SEED: 'yes' })).toThrow(/MIRSAD_DEMO_SEED/);
    expect(() => loadConfig({ MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS: 'telegram_business_live' })).toThrow(
      /MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS/,
    );
  });

  it('loadConfig rejects MIRSAD_WHATSAPP_IMPORT_ENABLED without a controlled-test record', () => {
    const missing = path.resolve('does-not-exist', 'controlled-test-record.json');
    expect(() =>
      loadConfig({ MIRSAD_WHATSAPP_IMPORT_ENABLED: 'true' }, { controlledTestRecordPath: missing }),
    ).toThrow(/MIRSAD_WHATSAPP_IMPORT_ENABLED/);
    expect(() => loadConfig({ MIRSAD_WHATSAPP_IMPORT_ENABLED: 'true' })).toThrow(ConfigError);
  });
});
