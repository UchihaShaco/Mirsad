/** Evidence files under <dataDir>/evidence/, written atomically (temp file, then rename). */
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

export function createLocalEvidenceStore(root: string): EvidenceStore {
  return {
    async put(key: string, bytes: Uint8Array): Promise<StoredEvidence> {
      const file = resolveKey(root, key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, bytes);
        await fs.rename(temp, file);
      } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
      }
      return { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.byteLength };
    },
    async get(key: string): Promise<Uint8Array> {
      const buffer = await fs.readFile(resolveKey(root, key));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    },
  };
}
