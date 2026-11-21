import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalEvidenceStore } from '../../src/storage/local-evidence-store.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-evidence-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('local evidence store', () => {
  it('writes bytes under the evidence directory and reads them back with checksum and size', async () => {
    const store = createLocalEvidenceStore(dir);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const key = 'captures/ws_1/chat_1/cap_1.png';
    const stored = await store.put(key, bytes);
    expect(stored).toEqual({ sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: 7 });
    expect(await store.get(key)).toEqual(bytes);
    expect(fs.existsSync(path.join(dir, 'captures', 'ws_1', 'chat_1', 'cap_1.png'))).toBe(true);
    const leftovers = fs.readdirSync(path.join(dir, 'captures', 'ws_1', 'chat_1'));
    expect(leftovers).toEqual(['cap_1.png']);
    await store.put(key, new Uint8Array([9]));
    expect(await store.get(key)).toEqual(new Uint8Array([9]));
  });

  it('refuses keys that could leave the evidence directory', async () => {
    const store = createLocalEvidenceStore(dir);
    for (const key of ['../escape.png', '/abs.png', 'captures/../../x.png', 'a\\b.png', '']) {
      await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow(/invalid_evidence_key/);
    }
    await expect(store.get('captures/ws_1/missing.png')).rejects.toThrow();
  });
});
