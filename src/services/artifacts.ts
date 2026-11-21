/**
 * Artifact reads and capture retries (design sections 6 and 9). Both follow the single chat access rule, and a
 * caller who cannot access the chat gets exactly the answer a missing ID gets. Stored bytes are served only after
 * their checksum is verified.
 */
import { createHash } from 'node:crypto';
import { AppError } from '../contract/errors.ts';
import type { Capture } from '../contract/schemas.ts';
import type { EvidenceStore } from '../ports/evidence-store.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { findArtifactById, type ArtifactRow } from '../storage/repos/artifacts.ts';
import { findCaptureById, requeueFailedCapture } from '../storage/repos/captures.ts';
import * as caseActions from '../storage/repos/case-actions.ts';
import { findChatById } from '../storage/repos/chats.ts';
import type { CaptureRow, ChatRow } from '../storage/rows.ts';
import { canAccessChat } from './access.ts';

/** The chat when the principal may access it (the rule requireChat applies), else undefined. */
function accessibleChat(tx: Tx, principal: Principal, chatId: string): ChatRow | undefined {
  const chat = findChatById(tx, chatId);
  return chat && canAccessChat(tx, principal, chat) ? chat : undefined;
}

export function readArtifact(tx: Tx, principal: Principal, artifactId: string): ArtifactRow {
  const artifact = findArtifactById(tx, artifactId);
  if (!artifact || !accessibleChat(tx, principal, artifact.chat_id)) {
    throw AppError.of('artifact_not_found', 'Artifact not found.');
  }
  return artifact;
}

const integrityError = (): AppError =>
  AppError.of('artifact_integrity_error', 'The stored file does not match its recorded checksum.');

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';

/** The artifact's bytes, only when their size and SHA-256 match the record; a missing file is an integrity error. */
export async function readVerifiedArtifactBytes(store: EvidenceStore, artifact: ArtifactRow): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await store.get(artifact.storage_key);
  } catch (error) {
    if (isMissingFile(error)) throw integrityError();
    throw error;
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== artifact.byte_size || sha256 !== artifact.sha256) throw integrityError();
  return bytes;
}

/** A queued capture has no image yet, so its checksum is null. */
function queuedCaptureView(row: CaptureRow): Capture {
  return {
    id: row.id,
    status: row.status,
    kind: 'mirsad_rendered_capture',
    artifactId: row.artifact_id,
    sha256: null,
    attempts: row.attempts,
    errorCode: row.last_error_code,
    retryable: row.status === 'failed',
    updatedAt: row.updated_at,
  };
}

/** Moves a failed capture back to pending and records who asked; the caller wakes the worker after commit. */
export function retryCapture(tx: Tx, officer: Principal, captureId: string): { capture: Capture } {
  const capture = findCaptureById(tx, captureId);
  const chat = capture && accessibleChat(tx, officer, capture.chat_id);
  if (!capture || !chat) throw AppError.of('capture_not_found', 'Capture not found.');
  const queued = requeueFailedCapture(tx, capture.id);
  if (!queued) {
    throw AppError.of('capture_not_retryable', 'Only a failed capture can be retried.', { status: capture.status });
  }
  caseActions.record(tx, {
    chatId: chat.id,
    workspaceId: chat.workspace_id,
    type: 'capture_retry_requested',
    actorId: officer.id,
    messageId: capture.message_id,
    detail: { captureId: capture.id, messageEventId: capture.message_event_id },
  });
  return { capture: queuedCaptureView(queued) };
}
