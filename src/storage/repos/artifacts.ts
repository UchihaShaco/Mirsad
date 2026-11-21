/** Stored evidence files (design section 4): one row per file under the evidence directory, never updated. */
import type { ArtifactKind } from '../../contract/enums.ts';
import type { Tx } from '../db.ts';

export interface ArtifactRow {
  id: string;
  chat_id: string;
  workspace_id: string;
  kind: ArtifactKind;
  media_type: string;
  storage_key: string;
  sha256: string;
  byte_size: number;
  created_at: string;
}

export interface InsertArtifactInput {
  id: string;
  chatId: string;
  workspaceId: string;
  kind: ArtifactKind;
  mediaType: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
}

export function insertArtifact(tx: Tx, input: InsertArtifactInput): ArtifactRow {
  const row = tx.get<ArtifactRow>(
    `INSERT INTO artifacts (id, chat_id, workspace_id, kind, media_type, storage_key, sha256, byte_size, created_at)
     VALUES (:id, :chatId, :workspaceId, :kind, :mediaType, :storageKey, :sha256, :byteSize, :at) RETURNING *`,
    { ...input, at: tx.now() },
  );
  if (!row) throw new Error('artifact_insert_failed');
  return row;
}

export function findArtifactById(tx: Tx, artifactId: string): ArtifactRow | undefined {
  return tx.get<ArtifactRow>('SELECT * FROM artifacts WHERE id = :artifactId', { artifactId });
}
