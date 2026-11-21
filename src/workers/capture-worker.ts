/**
 * Capture worker (design section 9). Claims the oldest pending capture in one transaction, renders the saved
 * record outside any transaction, then records the outcome in a second transaction. One capture at a time.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import type { CaptureMethod, CaptureStatus, MessageEventType } from '../contract/enums.ts';
import type { CaptureRenderInput } from '../ports/capture-renderer.ts';
import type { StoredEvidence } from '../ports/evidence-store.ts';
import { appendStreamEvent } from '../services/stream.ts';
import type { Tx } from '../storage/db.ts';
import { newId } from '../storage/ids.ts';
import { insertArtifact } from '../storage/repos/artifacts.ts';
import {
  claimOldestPendingCapture,
  findCaptureSource,
  markCaptureFailed,
  markCaptureReady,
  requeueRenderingCaptures,
  type CaptureSourceRow,
} from '../storage/repos/captures.ts';
import { createJobLoop, type JobLoop } from './job-loop.ts';

const CAPTURE_CONCURRENCY = 1;
const PNG_MEDIA_TYPE = 'image/png';
const UnsupportedContent = z.array(z.string());

type CaptureErrorCode = 'render_failed' | 'storage_failed';

interface CaptureJob {
  captureId: string;
  source: CaptureSourceRow;
}

const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Built only from server-generated IDs; rendering a capture again writes the same key, so it keeps one image. */
const storageKeyFor = (source: CaptureSourceRow): string =>
  `captures/${source.workspace_id}/${source.chat_id}/${source.capture_id}.png`;

function renderableEventType(type: MessageEventType): CaptureRenderInput['eventType'] {
  if (type === 'deleted') throw new Error('capture_event_not_renderable');
  return type;
}

/** "Name (id)" when the source gave both, else whichever it gave. */
function senderLabel(source: CaptureSourceRow): string | null {
  const name = source.sender_display_name || null;
  const externalId = source.sender_external_id || null;
  if (name && externalId) return `${name} (${externalId})`;
  return name ?? externalId;
}

/** The render input comes only from the capture's own message event and its message, chat and channel. */
function toRenderInput(source: CaptureSourceRow): CaptureRenderInput {
  const text = source.event_text ?? '';
  return {
    captureKind: 'mirsad_rendered_capture',
    channel: source.source,
    captureMethod: source.event_capture_method as CaptureMethod,
    chatLabel: source.chat_label,
    chatId: source.chat_id,
    messageId: source.message_id,
    messageEventId: source.message_event_id,
    eventType: renderableEventType(source.event_type),
    direction: source.direction,
    senderLabel: senderLabel(source),
    receivedAt: source.event_received_at,
    sentAt: source.event_source_occurred_at,
    text,
    textSha256: source.event_text_sha256 ?? sha256Hex(text),
    // Unsupported content is stored on the message, so only the original recording can show it.
    unsupportedContent: source.event_type === 'recorded' ? UnsupportedContent.parse(JSON.parse(source.unsupported_content)) : [],
  };
}

function claimNextCapture(tx: Tx): CaptureJob | null {
  const capture = claimOldestPendingCapture(tx);
  if (!capture) return null;
  const source = findCaptureSource(tx, capture.id);
  if (!source) throw new Error('capture_source_missing');
  return { captureId: capture.id, source };
}

function publishCaptureUpdate(tx: Tx, job: CaptureJob, status: CaptureStatus, artifactId: string | null): void {
  const { source } = job;
  appendStreamEvent(tx, {
    workspaceId: source.workspace_id,
    type: 'capture.updated',
    chatId: source.chat_id,
    data: { messageId: source.message_id, messageEventId: source.message_event_id, captureId: job.captureId, status, artifactId },
  });
}

function recordFailure(deps: AppDeps, job: CaptureJob, code: CaptureErrorCode, error: unknown): void {
  deps.db.transaction((tx) => {
    if (markCaptureFailed(tx, job.captureId, code)) publishCaptureUpdate(tx, job, 'failed', null);
  });
  deps.logger.warn('capture_failed', { captureId: job.captureId, code, errorClass: errorClassOf(error) });
}

/** One transaction: the artifact row, the capture linked to it as ready, and the stream event. */
function recordReady(deps: AppDeps, job: CaptureJob, stored: StoredEvidence): void {
  const { source } = job;
  const artifactId = deps.db.transaction((tx) => {
    const artifact = insertArtifact(tx, {
      id: newId('art'),
      chatId: source.chat_id,
      workspaceId: source.workspace_id,
      kind: 'mirsad_rendered_capture',
      mediaType: PNG_MEDIA_TYPE,
      storageKey: storageKeyFor(source),
      sha256: stored.sha256,
      byteSize: stored.byteSize,
    });
    if (!markCaptureReady(tx, job.captureId, artifact.id)) throw new Error('capture_not_rendering');
    publishCaptureUpdate(tx, job, 'ready', artifact.id);
    return artifact.id;
  });
  deps.logger.info('capture_ready', { captureId: job.captureId, artifactId, byteSize: stored.byteSize });
}

async function processCapture(deps: AppDeps, job: CaptureJob): Promise<void> {
  let png: Uint8Array;
  try {
    png = await deps.renderer.render(toRenderInput(job.source));
  } catch (error) {
    recordFailure(deps, job, 'render_failed', error);
    return;
  }
  try {
    recordReady(deps, job, await deps.evidenceStore.put(storageKeyFor(job.source), png));
  } catch (error) {
    recordFailure(deps, job, 'storage_failed', error);
  }
}

/**
 * Created once per start, before the first wake. Captures a stopped process left rendering are queued again; the
 * next render writes the same storage key, and the artifact row is only ever inserted with the ready status.
 */
export function createCaptureWorker(deps: AppDeps): JobLoop {
  const requeued = deps.db.transaction(requeueRenderingCaptures);
  if (requeued > 0) deps.logger.info('captures_requeued', { count: requeued });
  return createJobLoop<CaptureJob>({
    name: 'capture',
    concurrency: CAPTURE_CONCURRENCY,
    claim: () => deps.db.transaction(claimNextCapture),
    work: (job) => processCapture(deps, job),
    onError: (error, phase) => deps.logger.error('capture_worker_error', { phase, errorClass: errorClassOf(error) }),
  });
}
