import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { envelope, recorded } from '../helpers/events.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

let h: TestHarness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { h.renderer.release(); await h.close(); });

async function receive(externalId: string, messageId: number, account: 'intake' | 'officer' = 'intake') {
  const row = await h.http(h.tokens.connector).post('/v1/ingest', envelope(h.accounts[account], externalId, recorded({ messageId })));
  expect(row.status).toBe(201);
  return row.body.data.chatId as string;
}

it('rejects stale local erase, deletes capture files, and replays the receipt without erasing a new message', async () => {
  const id = await receive('erase-selected', 901);
  const api = h.http(h.tokens.officerA);
  const url = `/v1/chats/${id}/erase`;
  const first = (await api.get(url + '-preview')).body.data.snapshot;
  await receive('erase-selected', 902);
  await h.drain();
  const headers = { 'Idempotency-Key': 'selected-erase-test' };
  expect((await api.post(url, { expectedSnapshot: first, confirm: true }, headers)).status).toBe(409);
  const preview = (await api.get(url + '-preview')).body.data;
  expect(preview.chatCount).toBe(1);
  const ask = { expectedSnapshot: preview.snapshot, confirm: true };
  const timeline = async () => (await api.get(`/v1/chats/${id}/timeline`)).body.data;
  const before = await timeline();
  const evidence = path.join(h.dataDir, 'evidence');
  const images = () => fs.readdirSync(evidence, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.png'));
  expect(images()).toHaveLength(2);
  expect((await api.post(url, ask, headers)).body.data).toEqual({ chatCount: 1, filesPending: 0 });
  expect((await timeline()).messages).toHaveLength(0);
  expect(images()).toHaveLength(0);
  expect((await api.get(`/v1/artifacts/${before.messages[0].capture.artifactId}`)).status).toBe(404);
  h.clock.advance(3_000);
  await receive('erase-selected', 903);
  const replay = await api.post(url, ask, headers);
  expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
  expect((await timeline()).messages).toHaveLength(1);
});

it('erases all authorized inbox rows atomically and does not recreate an erased capture after rendering resumes', async () => {
  await receive('private-account', 912, 'officer');
  await h.drain();
  h.renderer.hold();
  await receive('first-clearable', 913);
  await receive('second-clearable', 914);
  await expect.poll(() => h.renderer.waiting).toBe(1);
  const officer = h.http(h.tokens.officerC);
  const preview = (await officer.get('/v1/inbox/erase-preview')).body.data;
  expect(preview.chatCount).toBe(2);
  const scope = { expectedSnapshot: preview.snapshot, confirm: true };
  const key = { 'Idempotency-Key': 'erase-granted-inbox' };
  expect((await h.http(h.tokens.outsider).post('/v1/inbox/erase', scope, key)).status).toBe(409);
  expect((await officer.post('/v1/inbox/erase', scope, key)).body.data).toEqual({ chatCount: 2, filesPending: 0 });
  h.renderer.release();
  await h.drain();
  expect((await officer.get('/v1/chats')).body.data.chats).toHaveLength(0);
  expect((await h.http(h.tokens.officerA).get('/v1/chats')).body.data.chats).toHaveLength(1);
  const files = fs.readdirSync(path.join(h.dataDir, 'evidence'), { recursive: true, encoding: 'utf8' });
  expect(files.filter(file => file.endsWith('.png'))).toHaveLength(1);
});

it('reports an incomplete file cleanup and retries it at service startup', async () => {
  const id = await receive('erase-recovery', 921);
  await h.drain();
  const root = path.join(h.dataDir, 'evidence');
  const key = fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).find(file => file.endsWith('.png'))!;
  const png = path.join(root, key);
  // This isolated fixture simulates a storage error without relying on platform-specific file permissions.
  fs.unlinkSync(png);
  fs.mkdirSync(png);
  const api = h.http(h.tokens.officerA);
  const url = `/v1/chats/${id}/erase`;
  const { snapshot } = (await api.get(url + '-preview')).body.data;
  const body = { expectedSnapshot: snapshot, confirm: true };
  const keyHeader = { 'Idempotency-Key': 'cleanup-recovery' };
  expect((await api.post(url, body, keyHeader)).body.data.filesPending).toBe(1);
  fs.rmdirSync(png);
  fs.writeFileSync(png, 'synthetic bytes awaiting deletion');
  await h.restart();
  expect(fs.existsSync(png)).toBe(false);
  expect((await api.post(url, body, keyHeader)).body.data.filesPending).toBe(0);
});
