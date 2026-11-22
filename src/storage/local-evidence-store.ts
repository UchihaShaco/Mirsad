/**
 * Evidence files under <dataDir>/evidence/, written atomically and durably: a temp file flushed to disk, then renamed,
 * then the directory flushed where the platform and the filesystem allow it (design section 9).
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createJsonLogger } from '../logging/json-logger.ts';
import type { EvidenceStore, StoredEvidence } from '../ports/evidence-store.ts';
import type { Logger } from '../ports/logger.ts';

const SEGMENT = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$/;
/**
 * What a filesystem that cannot flush a directory answers, such as some network, FUSE and container mounts. The file
 * itself is already flushed and in place, so the put stands.
 */
const DIRECTORY_FLUSH_UNSUPPORTED: ReadonlySet<string> = new Set(['EINVAL', 'EBADF', 'ENOTSUP', 'EPERM']);

/** The unsupported directory flush is logged once per process: every later put meets the same filesystem. */
let directoryFlushUnsupportedLogged = false;

export interface LocalEvidenceStoreOptions {
  /** Receives the one line saying the filesystem refuses directory flushes; defaults to a JSON logger on stdout. */
  logger?: Logger;
}

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

function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

/** Logs the code once per process, never the directory or the key. */
function reportFlushUnsupported(logger: Logger, code: string): void {
  if (directoryFlushUnsupportedLogged) return;
  directoryFlushUnsupportedLogged = true;
  logger.warn('evidence_directory_flush_unsupported', { code });
}

/**
 * Flushes a directory so a rename inside it survives a power cut. Windows refuses to flush a directory, so it is skipped
 * there. A filesystem that does not support it is reported and left as it is; any other error fails the put.
 */
async function flushDirectory(dir: string, logger: Logger): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code === null || !DIRECTORY_FLUSH_UNSUPPORTED.has(code)) throw error;
    reportFlushUnsupported(logger, code);
  } finally {
    await handle.close();
  }
}

export function createLocalEvidenceStore(root: string, options: LocalEvidenceStoreOptions = {}): EvidenceStore {
  const logger = options.logger ?? createJsonLogger();
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
      await flushDirectory(path.dirname(file), logger);
      return { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.byteLength };
    },
    async get(key: string): Promise<Uint8Array> {
      const buffer = await fs.readFile(resolveKey(root, key));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    },
  };
}
