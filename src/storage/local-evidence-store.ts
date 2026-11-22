/**
 * Evidence files under <dataDir>/evidence/, written atomically and durably: a temp file flushed to disk, then renamed,
 * then the directory flushed where the platform allows it (design section 9).
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EvidenceStore, StoredEvidence } from '../ports/evidence-store.ts';

const SEGMENT = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$/;

function resolveKey(root: string, key: string): string {
  const segments = key.split('/');
  if (key === '' || segments.some((s) => !SEGMENT.test(s))) throw new Error('invalid_evidence_key');
  return path.join(root, ...segments);
}

/** Writes the bytes and flushes them to disk before the file is closed. */
async function writeFlushed(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(file, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flushes a directory so a rename inside it survives a power cut. Windows refuses to flush a directory, so it is skipped there. */
async function flushDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createLocalEvidenceStore(root: string): EvidenceStore {
  return {
    async put(key: string, bytes: Uint8Array): Promise<StoredEvidence> {
      const file = resolveKey(root, key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFlushed(temp, bytes);
        await fs.rename(temp, file);
      } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
      }
      await flushDirectory(path.dirname(file));
      return { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.byteLength };
    },
    async get(key: string): Promise<Uint8Array> {
      const buffer = await fs.readFile(resolveKey(root, key));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    },
  };
}
