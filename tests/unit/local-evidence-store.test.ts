import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LogFields, Logger } from '../../src/ports/logger.ts';
import { createLocalEvidenceStore } from '../../src/storage/local-evidence-store.ts';

let dir: string;
const realPlatform = process.platform;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-evidence-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: realPlatform });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** The prototype every FileHandle shares, found through a handle of a scratch file. */
async function fileHandlePrototype(): Promise<FileHandle> {
  const handle = await fsPromises.open(path.join(dir, 'probe'), 'w');
  await handle.close();
  return Object.getPrototypeOf(handle) as FileHandle;
}

/**
 * Records each flush (FileHandle.sync) and rename in the order they happen. With `flush: 'real'` a flush still reaches
 * the disk; with 'recorded' it is only recorded, so a directory flush can be observed on a platform that refuses it.
 */
async function recordFlushesAndRenames(flush: 'real' | 'recorded'): Promise<string[]> {
  const order: string[] = [];
  const prototype = await fileHandlePrototype();
  const realSync = prototype.sync;
  vi.spyOn(prototype, 'sync').mockImplementation(function (this: FileHandle) {
    order.push('sync');
    return flush === 'real' ? realSync.call(this) : Promise.resolve();
  });
  const realRename = fsPromises.rename;
  vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    order.push('rename');
    return realRename(from, to);
  });
  return order;
}

/**
 * On a platform that flushes directories, the file flush still reaches the disk, and the directory flush after the
 * rename fails with the given error code, as some network, FUSE and container mounts answer it.
 */
async function failDirectoryFlush(code: string): Promise<void> {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const prototype = await fileHandlePrototype();
  const realSync = prototype.sync;
  let renamed = false;
  const realRename = fsPromises.rename;
  vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    await realRename(from, to);
    renamed = true;
  });
  vi.spyOn(prototype, 'sync').mockImplementation(function (this: FileHandle) {
    return renamed ? Promise.reject(Object.assign(new Error(`${code}: fsync refused`), { code })) : realSync.call(this);
  });
}

type LogLine = [level: string, event: string, fields: LogFields | undefined];

/** A logger that keeps every line it is given. */
function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const keep = (level: string) => (event: string, fields?: LogFields) => {
    lines.push([level, event, fields]);
  };
  return { logger: { info: keep('info'), warn: keep('warn'), error: keep('error') }, lines };
}

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

  it('flushes the evidence file to disk before the rename that makes it visible', async () => {
    const order = await recordFlushesAndRenames('real');
    const store = createLocalEvidenceStore(dir);
    const bytes = new Uint8Array([137, 80, 78, 71, 4, 5, 6]);
    await store.put('captures/ws_1/chat_1/cap_2.png', bytes);
    expect(order.slice(0, 2)).toEqual(['sync', 'rename']);
    expect(await store.get('captures/ws_1/chat_1/cap_2.png')).toEqual(bytes);
  });

  it('flushes the directory after the rename where the platform allows it, and skips that step on Windows', async () => {
    for (const [platform, expected] of [['linux', ['sync', 'rename', 'sync']], ['win32', ['sync', 'rename']]] as const) {
      Object.defineProperty(process, 'platform', { value: platform });
      const order = await recordFlushesAndRenames('recorded');
      await createLocalEvidenceStore(dir).put(`captures/ws_1/chat_1/cap_${platform}.png`, new Uint8Array([1, 2, 3]));
      expect(order, platform).toEqual(expected);
      vi.restoreAllMocks();
    }
  });

  it('a directory flush the filesystem refuses as unsupported leaves the stored file in place, logged once and by code only', async () => {
    const { logger, lines } = recordingLogger();
    for (const code of ['EINVAL', 'EBADF', 'ENOTSUP', 'EPERM']) {
      await failDirectoryFlush(code);
      const store = createLocalEvidenceStore(dir, { logger });
      const key = `captures/ws_1/chat_1/cap_${code}.png`;
      const bytes = new Uint8Array([137, 80, 78, 71, code.length]);
      await expect(store.put(key, bytes), code).resolves.toEqual({ sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: 5 });
      expect(await store.get(key), code).toEqual(bytes);
      vi.restoreAllMocks();
    }
    expect(lines).toEqual([['warn', 'evidence_directory_flush_unsupported', { code: 'EINVAL' }]]);
  });

  it('any other directory flush error fails the put', async () => {
    await failDirectoryFlush('EIO');
    const put = createLocalEvidenceStore(dir).put('captures/ws_1/chat_1/cap_eio.png', new Uint8Array([1, 2, 3]));
    await expect(put).rejects.toMatchObject({ code: 'EIO' });
  });

  it('refuses keys that could leave the evidence directory', async () => {
    const store = createLocalEvidenceStore(dir);
    for (const key of ['../escape.png', '/abs.png', 'captures/../../x.png', 'a\\b.png', '']) {
      await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow(/invalid_evidence_key/);
    }
    await expect(store.get('captures/ws_1/missing.png')).rejects.toThrow();
  });
});
