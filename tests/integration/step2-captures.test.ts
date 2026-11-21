import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EVIDENCE_DIRECTORY } from '../../src/app.ts';
import { readTextChunks } from '../../src/capture/png-metadata.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';
import { execSql, queryRows, streamEvents } from '../helpers/db-read.ts';
import { edited, envelope, recorded, uniqueId } from '../helpers/events.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MISSING_ARTIFACT_ID = 'art_00000000000000000000000000000000';
const WAIT_LIMIT_MS = 5_000;
const POLL_INTERVAL_MS = 5;

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
afterEach(async () => {
  h.renderer.release();
  await h.drain();
});

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

async function ingest(body: unknown) {
  return h.http(h.tokens.connector).post('/v1/ingest', body);
}

async function timeline(chatId: string, token = h.tokens.officerA) {
  return (await h.http(token).get(`/v1/chats/${chatId}/timeline`)).body.data;
}

async function retry(captureId: string, token = h.tokens.officerA) {
  return h.http(token).post(`/v1/captures/${captureId}/retry`);
}

/** Ingests one message on the officer account (officer C has no grant there) and waits for its capture. */
async function capturedMessage(text: string, direction: 'incoming' | 'outgoing' = 'incoming') {
  const res = await ingest(envelope(h.accounts.officer, uniqueId('cap-'), recorded({ messageId: 1, text, direction })));
  expect(res.status).toBe(201);
  await h.drain();
  const [message] = (await timeline(res.body.data.chatId)).messages;
  return { ingested: res.body.data, message };
}

interface ArtifactResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  body: any;
}

/** GET /v1/artifacts/{id} with the raw bytes kept (the JSON helper would decode a PNG as text). */
async function fetchArtifact(artifactId: string, token: string | null = h.tokens.officerA): Promise<ArtifactResponse> {
  const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` };
  const res = await fetch(`${h.baseUrl}/v1/artifacts/${artifactId}`, { headers });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { status: res.status, headers: res.headers, bytes, body: isJson ? JSON.parse(Buffer.from(bytes).toString('utf8')) : null };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function evidenceFile(artifactId: string): string {
  const [row] = queryRows<{ storage_key: string }>(h.dataDir, 'SELECT storage_key FROM artifacts WHERE id = :id', { id: artifactId });
  if (!row) throw new Error(`no artifact row for ${artifactId}`);
  return path.join(h.dataDir, EVIDENCE_DIRECTORY, ...row.storage_key.split('/'));
}

/** Where a chat's capture images live: captures/<workspaceId>/<chatId>/ under the evidence directory (design section 9). */
function chatEvidenceFolder(chatId: string): string {
  const [chat] = queryRows<{ workspace_id: string }>(h.dataDir, 'SELECT workspace_id FROM chats WHERE id = :id', { id: chatId });
  if (!chat) throw new Error(`no chat row for ${chatId}`);
  return path.join(h.dataDir, EVIDENCE_DIRECTORY, 'captures', chat.workspace_id, chatId);
}

describe('step 2: captures and artifacts', () => {
  it('a rendering failure leaves the message readable and marks the capture failed and retryable', async () => {
    h.renderer.failNext();
    const res = await ingest(envelope(h.accounts.officer, uniqueId('fail-'), recorded({ messageId: 1, text: 'Please confirm the delivery address' })));
    expect(res.status).toBe(201);
    const { chatId, captureId, messageId, messageEventId } = res.body.data;
    await h.drain();

    const [message] = (await timeline(chatId)).messages;
    expect(message).toMatchObject({
      id: messageId,
      text: 'Please confirm the delivery address',
      capture: { id: captureId, status: 'failed', errorCode: 'render_failed', retryable: true, artifactId: null, sha256: null, attempts: 1 },
    });
    const updates = streamEvents(h.dataDir, chatId).filter((e) => e.type === 'capture.updated');
    expect(updates.map((e) => e.data)).toEqual([{ messageId, messageEventId, captureId, status: 'failed', artifactId: null }]);
  });

  it('a storage failure marks the capture failed with storage_failed, and a retry stores the image', async () => {
    h.renderer.hold();
    const res = await ingest(envelope(h.accounts.officer, uniqueId('store-'), recorded({ messageId: 1, text: 'Stored after a retry' })));
    const { chatId, captureId } = res.body.data;
    await until(() => h.renderer.waiting === 1, 'the render to start');
    const chatFolder = chatEvidenceFolder(chatId);
    fs.mkdirSync(path.dirname(chatFolder), { recursive: true });
    fs.writeFileSync(chatFolder, 'a file where the chat folder belongs');
    h.renderer.release();
    await h.drain();

    const [message] = (await timeline(chatId)).messages;
    expect(message).toMatchObject({ text: 'Stored after a retry', capture: { id: captureId, status: 'failed', errorCode: 'storage_failed', retryable: true } });
    fs.rmSync(chatFolder);
    expect((await retry(captureId)).status).toBe(200);
    await h.drain();
    expect((await timeline(chatId)).messages[0].capture).toMatchObject({ status: 'ready', errorCode: null });
  });

  it('retry after a failure produces exactly one linked image whose SHA-256 matches the stored checksum', async () => {
    h.renderer.failNext();
    const res = await ingest(envelope(h.accounts.officer, uniqueId('retry-'), recorded({ messageId: 1, text: 'Retry this capture' })));
    const { chatId, captureId, messageId, messageEventId } = res.body.data;
    await h.drain();
    expect((await timeline(chatId)).messages[0].capture.status).toBe('failed');

    const retried = await retry(captureId);
    expect(retried.status).toBe(200);
    expect(retried.body.data.capture).toMatchObject({
      id: captureId, status: 'pending', kind: 'mirsad_rendered_capture', artifactId: null, sha256: null, attempts: 1, errorCode: null, retryable: false,
    });
    await h.drain();

    const tl = await timeline(chatId);
    const capture = tl.messages[0].capture;
    expect(capture).toMatchObject({ id: captureId, status: 'ready', attempts: 2, errorCode: null, retryable: false });
    const artifacts = queryRows<{ id: string; sha256: string }>(h.dataDir, 'SELECT id, sha256 FROM artifacts WHERE chat_id = :chatId', { chatId });
    expect(artifacts).toEqual([{ id: capture.artifactId, sha256: capture.sha256 }]);
    const image = await fetchArtifact(capture.artifactId);
    expect(sha256(image.bytes)).toBe(capture.sha256);
    expect(image.headers.get('x-mirsad-sha256')).toBe(capture.sha256);
    expect(readTextChunks(image.bytes)['Mirsad-Message-Id']).toBe(messageId);

    expect(tl.caseActions).toEqual([
      expect.objectContaining({
        type: 'capture_retry_requested', actor: expect.objectContaining({ displayName: 'Officer A' }), messageId, detail: { captureId, messageEventId },
      }),
    ]);
    const statuses = streamEvents(h.dataDir, chatId).filter((e) => e.type === 'capture.updated').map((e) => e.data.status);
    expect(statuses).toEqual(['failed', 'ready']);
  });

  it('retrying a capture that is not failed is 409 capture_not_retryable', async () => {
    const { ingested } = await capturedMessage('Already rendered');
    const ready = await retry(ingested.captureId);
    expect(ready.status).toBe(409);
    expect(ready.body.error).toMatchObject({ code: 'capture_not_retryable', details: { status: 'ready' } });

    const chat = uniqueId('busy-');
    h.renderer.hold();
    const rendering = await ingest(envelope(h.accounts.officer, chat, recorded({ messageId: 1, text: 'Being rendered' })));
    await until(() => h.renderer.waiting === 1, 'the first render to start');
    const pending = await ingest(envelope(h.accounts.officer, chat, recorded({ messageId: 2, text: 'Waiting its turn' })));
    for (const [captureId, status] of [[rendering.body.data.captureId, 'rendering'], [pending.body.data.captureId, 'pending']]) {
      const refused = await retry(captureId);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatchObject({ code: 'capture_not_retryable', details: { status } });
    }
    h.renderer.release();
    await h.drain();
    const retries = queryRows(h.dataDir, "SELECT id FROM case_actions WHERE type = 'capture_retry_requested' AND chat_id IN (:a, :b)", {
      a: ingested.chatId,
      b: rendering.body.data.chatId,
    });
    expect(retries).toEqual([]);
  });

  it('retrying a capture the caller cannot access answers like a missing capture', async () => {
    h.renderer.failNext();
    const res = await ingest(envelope(h.accounts.officer, uniqueId('retry-acl-'), recorded({ messageId: 1, text: 'Officer C cannot see this chat' })));
    const { chatId, captureId } = res.body.data;
    await h.drain();

    const missing = await retry('cap_00000000000000000000000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('capture_not_found');
    for (const token of [h.tokens.officerC, h.tokens.outsider]) {
      const denied = await retry(captureId, token);
      expect(denied.status).toBe(404);
      expect(denied.body).toEqual(missing.body);
    }
    expect((await retry(captureId, h.tokens.connector)).status).toBe(403);
    expect((await timeline(chatId)).messages[0].capture.status).toBe('failed');
  });

  it('the message is readable while its capture is still pending', async () => {
    const chat = uniqueId('pending-');
    h.renderer.hold();
    const first = await ingest(envelope(h.accounts.officer, chat, recorded({ messageId: 10, text: 'First of two messages' })));
    await until(() => h.renderer.waiting === 1, 'the first render to start');
    const second = await ingest(envelope(h.accounts.officer, chat, recorded({ messageId: 11, text: 'Second of two messages' })));
    const chatId: string = first.body.data.chatId;

    const during = await timeline(chatId);
    expect(during.messages.map((m: any) => [m.text, m.capture.status])).toEqual([
      ['First of two messages', 'rendering'],
      ['Second of two messages', 'pending'],
    ]);
    expect(during.messages[1].capture).toMatchObject({ id: second.body.data.captureId, artifactId: null, sha256: null, attempts: 0, retryable: false });

    h.renderer.release();
    await h.drain();
    const after = await timeline(chatId);
    expect(after.messages.map((m: any) => [m.text, m.capture.status])).toEqual([
      ['First of two messages', 'ready'],
      ['Second of two messages', 'ready'],
    ]);
  });

  it('when a second message arrives before the first image is rendered, each image carries its own message', async () => {
    const chat = uniqueId('order-');
    h.renderer.hold();
    const first = await ingest(envelope(h.accounts.officer, chat, recorded({ messageId: 20, text: 'Meet at the north gate' })));
    await until(() => h.renderer.waiting === 1, 'the first render to start');
    // Both later messages are saved while the first image is held, so the capture of message 21 is claimed when
    // message 22 already exists: an image built from the chat's newest message instead of its own fails below.
    const second = await ingest(envelope(h.accounts.officer, chat, recorded({ messageId: 21, text: 'Change of plan: the south gate' })));
    const third = await ingest(envelope(h.accounts.officer, chat, recorded({ messageId: 22, text: 'Bring the blue folder' })));
    h.renderer.release();
    await h.drain();

    const chatId: string = first.body.data.chatId;
    const eventIds = new Map([first, second, third].map((r) => [r.body.data.messageId as string, r.body.data.messageEventId as string]));
    const { messages } = await timeline(chatId);
    expect(messages.map((m: any) => m.text)).toEqual(['Meet at the north gate', 'Change of plan: the south gate', 'Bring the blue folder']);
    for (const message of messages) {
      expect(message.capture).toMatchObject({ status: 'ready', artifactId: expect.stringMatching(/^art_[0-9a-f]{32}$/) });
      const image = await fetchArtifact(message.capture.artifactId);
      expect(image.status).toBe(200);
      expect(readTextChunks(image.bytes)).toEqual({
        'Mirsad-Capture-Kind': 'mirsad_rendered_capture',
        'Mirsad-Chat-Id': chatId,
        'Mirsad-Message-Id': message.id,
        'Mirsad-Message-Event-Id': eventIds.get(message.id),
        'Mirsad-Received-At': message.receivedAt,
        'Mirsad-Text-SHA256': sha256(message.text),
      });
    }
    const rendered = h.renderer.inputs.filter((input) => input.chatId === chatId).map((input) => [input.messageId, input.text]);
    expect(rendered).toEqual(messages.map((m: any) => [m.id, m.text]));
  });

  it('an edit gets its own capture and the original capture is unchanged', async () => {
    const { ingested, message } = await capturedMessage('Pay to account A');
    const before = message.capture;
    expect(before).toMatchObject({ status: 'ready' });
    const originalBytes = (await fetchArtifact(before.artifactId)).bytes;

    const edit = await h.http(h.tokens.connector).post(`/v1/chats/${ingested.chatId}/events`, edited({ messageId: 1, updateId: 3001, text: 'Pay to account B' }));
    expect(edit.status).toBe(201);
    await h.drain();

    const tl = await timeline(ingested.chatId);
    expect(tl.messages[0].capture).toEqual(before);
    const editEvent = tl.messageEvents.find((e: any) => e.type === 'edited');
    expect(editEvent.capture).toMatchObject({ id: edit.body.data.captureId, status: 'ready' });
    expect(editEvent.capture.artifactId).not.toBe(before.artifactId);
    const editImage = await fetchArtifact(editEvent.capture.artifactId);
    expect(readTextChunks(editImage.bytes)).toMatchObject({
      'Mirsad-Message-Id': message.id,
      'Mirsad-Message-Event-Id': editEvent.id,
      'Mirsad-Text-SHA256': sha256('Pay to account B'),
    });
    expect(h.renderer.inputs.find((input) => input.messageEventId === editEvent.id)).toMatchObject({ eventType: 'edited', text: 'Pay to account B' });
    const original = await fetchArtifact(before.artifactId);
    expect(Buffer.from(original.bytes).equals(Buffer.from(originalBytes))).toBe(true);
    expect(sha256(original.bytes)).toBe(before.sha256);
  });

  it('a conflicting copy is captured as its own event with its own text', async () => {
    const { ingested, message } = await capturedMessage('Pay to account A');
    const redelivered = await h.http(h.tokens.connector).post(`/v1/chats/${ingested.chatId}/events`, recorded({ messageId: 1, updateId: 4001, text: 'Pay to account C' }));
    expect(redelivered.body.data).toMatchObject({ result: 'conflicting_copy', messageId: message.id });
    await h.drain();

    const tl = await timeline(ingested.chatId);
    expect(tl.messages[0]).toMatchObject({ text: 'Pay to account A', capture: message.capture });
    const copyEvent = tl.messageEvents.find((e: any) => e.type === 'conflicting_copy');
    expect(copyEvent.capture).toMatchObject({ id: redelivered.body.data.captureId, status: 'ready' });
    expect(h.renderer.inputs.find((input) => input.messageEventId === copyEvent.id)).toMatchObject({ eventType: 'conflicting_copy', text: 'Pay to account C' });
    const image = await fetchArtifact(copyEvent.capture.artifactId);
    expect(readTextChunks(image.bytes)).toMatchObject({ 'Mirsad-Message-Event-Id': copyEvent.id, 'Mirsad-Text-SHA256': sha256('Pay to account C') });
  });

  it('outgoing source messages are captured too', async () => {
    const { message } = await capturedMessage('Thanks, noted.', 'outgoing');
    expect(message).toMatchObject({ direction: 'outgoing', capture: { status: 'ready' } });
    const image = await fetchArtifact(message.capture.artifactId);
    expect(image.status).toBe(200);
    expect(readTextChunks(image.bytes)['Mirsad-Message-Id']).toBe(message.id);
    expect(h.renderer.inputs.find((input) => input.messageId === message.id)).toMatchObject({ direction: 'outgoing', text: 'Thanks, noted.' });
  });

  it('artifact bytes are served only to officers with chat access', async () => {
    const { message } = await capturedMessage('Evidence for officers of this chat only');
    const { artifactId } = message.capture;
    expect((await fetchArtifact(artifactId, h.tokens.officerA)).status).toBe(200);
    expect((await fetchArtifact(artifactId, h.tokens.officerB)).status).toBe(200);

    const missing = await fetchArtifact(MISSING_ARTIFACT_ID);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('artifact_not_found');
    for (const token of [h.tokens.officerC, h.tokens.outsider]) {
      const denied = await fetchArtifact(artifactId, token);
      expect(denied.status).toBe(404);
      expect(denied.body).toEqual(missing.body);
    }
    const connector = await fetchArtifact(artifactId, h.tokens.connector);
    expect(connector.status).toBe(403);
    expect(connector.body.error.code).toBe('forbidden_for_principal');
    expect((await fetchArtifact(artifactId, null)).status).toBe(401);
  });

  it('artifact responses are private, no-store and carry the checksum header', async () => {
    const { message } = await capturedMessage('Headers check');
    const image = await fetchArtifact(message.capture.artifactId);
    expect(image.status).toBe(200);
    expect([...image.bytes.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('private, no-store');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('content-disposition')).toBe(`inline; filename="${message.capture.artifactId}.png"`);
    expect(image.headers.get('x-mirsad-sha256')).toBe(sha256(image.bytes));
    expect(message.capture.sha256).toBe(sha256(image.bytes));
  });

  it('a tampered evidence file is refused with artifact_integrity_error', async () => {
    const { ingested, message } = await capturedMessage('Do not alter this record');
    const { artifactId } = message.capture;
    const file = evidenceFile(artifactId);
    expect(file).toBe(path.join(chatEvidenceFolder(ingested.chatId), `${ingested.captureId}.png`));

    const tampered = Buffer.from(fs.readFileSync(file));
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 20) ^ 0xff, tampered.length - 20);
    fs.writeFileSync(file, tampered);
    const refused = await fetchArtifact(artifactId);
    expect(refused.status).toBe(500);
    expect(refused.body).toMatchObject({ success: false, data: null, error: { code: 'artifact_integrity_error' } });
    expect(refused.headers.get('x-mirsad-sha256')).toBeNull();
    expect(h.logs.some((line) => JSON.parse(line).code === 'artifact_integrity_error')).toBe(true);

    fs.rmSync(file);
    const gone = await fetchArtifact(artifactId);
    expect(gone.status).toBe(500);
    expect(gone.body.error.code).toBe('artifact_integrity_error');
  });

  it('captures left rendering are finished after a restart without a duplicate artifact', async () => {
    const chat = uniqueId('restart-');
    h.renderer.hold();
    const first = await ingest(envelope(h.accounts.officer, chat, recorded({ messageId: 1, text: 'Rendered before the restart' })));
    await until(() => h.renderer.waiting === 1, 'the first render to start');
    const second = await ingest(envelope(h.accounts.officer, chat, recorded({ messageId: 2, text: 'Interrupted by the restart' })));
    const { chatId, captureId, messageEventId } = second.body.data;
    expect(first.body.data.chatId).toBe(chatId);

    // The state a stopped process leaves behind: the capture claimed and its file written, but no artifact recorded.
    execSql(h.dataDir, "UPDATE captures SET status = 'rendering', attempts = attempts + 1 WHERE id = :id", { id: captureId });
    const leftover = path.join(chatEvidenceFolder(chatId), `${captureId}.png`);
    fs.mkdirSync(path.dirname(leftover), { recursive: true });
    fs.writeFileSync(leftover, 'partial image from the stopped process');
    h.renderer.release();
    await h.drain();
    expect((await timeline(chatId)).messages.map((m: any) => m.capture.status)).toEqual(['ready', 'rendering']);

    await h.restart();
    await h.drain();

    const capture = (await timeline(chatId)).messages[1].capture;
    expect(capture).toMatchObject({ id: captureId, status: 'ready', attempts: 2, errorCode: null });
    const artifacts = queryRows<{ id: string; storage_key: string }>(h.dataDir, 'SELECT id, storage_key FROM artifacts WHERE chat_id = :chatId', { chatId });
    expect(artifacts).toHaveLength(2);
    expect(artifacts.filter((row) => row.storage_key.endsWith(`/${captureId}.png`)).map((row) => row.id)).toEqual([capture.artifactId]);
    expect(sha256(fs.readFileSync(leftover))).toBe(capture.sha256);
    expect((await fetchArtifact(capture.artifactId)).status).toBe(200);
    expect(h.renderer.inputs.filter((input) => input.messageEventId === messageEventId)).toHaveLength(1);
  });
});
