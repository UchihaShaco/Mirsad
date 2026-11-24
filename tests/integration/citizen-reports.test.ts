/**
 * Citizen reports from Mirsad Android: an officer imports the report file a citizen shared; it becomes a message in a
 * Citizen report chat, the numbers it names enter the phone watchlist for review, and nothing can dispatch, take over
 * or answer it. Fixtures are the shared files in contracts/fixtures (fictional numbers, .example domains).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countRows } from '../helpers/db-read.ts';
import { envelope, recorded, uniqueId } from '../helpers/events.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${name}`, import.meta.url), 'utf8'));
const REAL = fixture('citizen-report.v1.json');
const DEMO = fixture('citizen-report.v1.demo.json');
const FALSE_POSITIVE = fixture('false-positive-report.v1.json');

let h: TestHarness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

const officerA = () => h.http(h.tokens.officerA);
const importReport = (report: unknown, demo?: boolean, token = h.tokens.officerA) =>
  h.http(token).post('/v1/citizen-reports', { report, ...(demo !== undefined && { demo }) });
const summaryOf = async (chatId: string, token = h.tokens.officerA) =>
  (await h.http(token).get('/v1/chats')).body.data.chats.find((c: { id: string }) => c.id === chatId);
const entryFor = async (e164: string) =>
  (await officerA().get('/v1/watchlist')).body.data.entries.find((e: { number: { e164: string } }) => e.number.e164 === e164);

describe('citizen reports', () => {
  it('imports a report as a Citizen report chat and sends its numbers to the watchlist for review', async () => {
    const res = await importReport(REAL);
    expect(res.status, res.text).toBe(201);
    expect(res.body.data).toMatchObject({ created: true, demo: false, watchlistNumbers: 2 });
    const { chatId, messageId } = res.body.data;

    const chat = await summaryOf(chatId);
    expect(chat).toMatchObject({ source: 'citizen_report', channelLabel: 'Citizen report', displayLabel: '+971500000301',
      citizenReport: { count: 1, latestLevel: 'HOLD', latestChannel: 'SMS', demo: false } });
    const timeline = (await officerA().get(`/v1/chats/${chatId}/timeline`)).body.data;
    expect(timeline.messages).toHaveLength(1);
    expect(timeline.messages[0]).toMatchObject({ id: messageId, direction: 'incoming',
      text: 'Scam SMS held on a citizen’s phone (risk 91%). The citizen did not share the message text.' });
    expect(timeline.citizenReports).toEqual([expect.objectContaining({ messageId, reportId: REAL.reportId, level: 'HOLD', score: 0.912,
      demo: false, textShared: false, reasonCodes: REAL.reasonCodes, artifacts: REAL.artifacts, importedBy: expect.objectContaining({ displayName: expect.any(String) }) })]);
    expect(timeline.caseActions.map((a: { type: string }) => a.type)).toContain('citizen_report_imported');
    expect(timeline.telegramReplies).toBeUndefined();

    const expected: [string, string][] = [['+971500000301', 'Sender of a scam SMS a citizen’s phone held'], ['+971500000302', 'Named in a scam message a citizen reported']];
    for (const [e164, reason] of expected) {
      const entry = await entryFor(e164);
      expect(entry).toMatchObject({ status: 'needs_review', canReview: true,
        evidence: [expect.objectContaining({ chatId, messageId, origin: 'citizen_report', reason })] });
    }
  });

  it('treats a re-shared report as the same report and groups a sender’s reports in one chat', async () => {
    const first = await importReport(REAL);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ created: false, watchlistNumbers: 0 });
    const second = await importReport({ ...REAL, reportId: 'mrs-0a1b2c3d4e60', text: 'Abu Dhabi Police: pay your fine today at http://adpolice-fines.example/pay' });
    expect(second.status, second.text).toBe(201);
    expect(second.body.data.chatId).toBe(first.body.data.chatId);
    const chat = await summaryOf(first.body.data.chatId);
    expect(chat.citizenReport).toMatchObject({ count: 2 });
    const timeline = (await officerA().get(`/v1/chats/${chat.id}/timeline`)).body.data;
    expect(timeline.messages.map((m: { text: string }) => m.text)).toContain('Abu Dhabi Police: pay your fine today at http://adpolice-fines.example/pay');
    expect(timeline.citizenReports.map((r: { textShared: boolean }) => r.textShared)).toEqual([false, true]);
  });

  it('refuses a demo report unless asked, and a demo report never reaches the watchlist', async () => {
    const refused = await importReport(DEMO);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('report_not_accepted');
    const imported = await importReport(DEMO, true);
    expect(imported.status, imported.text).toBe(201);
    expect(imported.body.data).toMatchObject({ demo: true, watchlistNumbers: 0 });
    expect(await entryFor('+440000000001')).toBeUndefined();
    expect((await summaryOf(imported.body.data.chatId)).citizenReport).toMatchObject({ demo: true });
  });

  it('refuses a false-positive report, another version and a file that is not a report', async () => {
    const fp = await importReport(FALSE_POSITIVE);
    expect([fp.status, fp.body.error.code]).toEqual([422, 'report_not_accepted']);
    const v2 = await importReport({ ...REAL, version: 2 });
    expect([v2.status, v2.body.error.code]).toEqual([422, 'report_not_accepted']);
    const junk = await importReport({ hello: 'world' });
    expect([junk.status, junk.body.error.code]).toEqual([400, 'validation_failed']);
    expect((await h.http(h.tokens.connector).post('/v1/citizen-reports', { report: REAL })).status).toBe(403);
  });

  it('can never be dispatched, taken over or written into through ingest', async () => {
    const { chatId } = (await importReport({ ...REAL, reportId: 'mrs-0a1b2c3d4e61', artifacts: { ...REAL.artifacts, sender: '+971500000303', phones: [] } })).body.data;
    const chat = await summaryOf(chatId);
    const dispatch = await officerA().post('/v1/dispatches', { chatIds: [chatId] }, { 'Idempotency-Key': uniqueId('key-') });
    expect([dispatch.status, dispatch.body.error.code]).toEqual([409, 'citizen_report_only']);
    const takeOver = await officerA().post(`/v1/chats/${chatId}/control`, { action: 'take_over', expectedRevision: chat.revision });
    expect([takeOver.status, takeOver.body.error.code]).toEqual([409, 'citizen_report_only']);
    const ingest = await h.http(h.tokens.connector).post('/v1/ingest',
      { ...envelope(h.accounts.intake, '+971500000303', recorded({ messageId: 9, text: 'x' })), source: 'citizen_report', externalAccountId: 'mirsad-android' });
    expect([ingest.status, ingest.body.error.code]).toEqual([400, 'validation_failed']);
    const register = await officerA().post('/v1/chats', { source: 'citizen_report', externalAccountId: 'mirsad-android', externalChatId: 'x', displayLabel: 'x' });
    expect(register.status).toBe(400);
    expect(await summaryOf(chatId)).toMatchObject({ aiMode: 'not_started', revision: chat.revision });
  });

  it('is visible to every officer of the workspace and to no one outside it', async () => {
    const { chatId } = (await importReport(REAL)).body.data;
    expect(await summaryOf(chatId, h.tokens.officerB)).toBeDefined();
    expect(await summaryOf(chatId, h.tokens.officerC)).toBeDefined();
    expect(await summaryOf(chatId, h.tokens.outsider)).toBeUndefined();
    expect((await h.http(h.tokens.outsider).get(`/v1/chats/${chatId}/timeline`)).status).toBe(404);
  });

  it('lets an officer flag the reported sender, which moves the chat to Suspects', async () => {
    const { chatId } = (await importReport({ ...REAL, reportId: 'mrs-0a1b2c3d4e62', artifacts: { ...REAL.artifacts, sender: '+971500000304', phones: [] } })).body.data;
    const flag = await officerA().post(`/v1/chats/${chatId}/scammer-flags`, { phone: '+971500000304', reason: 'Fake police fine reported by a citizen.' });
    expect(flag.status, flag.text).toBe(201);
    expect((await summaryOf(chatId)).suspect).toMatchObject({ numberDisplay: '+971500000304' });
    expect((await entryFor('+971500000304')).status).toBe('approved');
  });

  it('is removed with its chat when the chat is erased', async () => {
    const { chatId } = (await importReport({ ...REAL, reportId: 'mrs-0a1b2c3d4e63', artifacts: { ...REAL.artifacts, sender: '+971500000305', phones: [] } })).body.data;
    const preview = await officerA().get(`/v1/chats/${chatId}/erase-preview`);
    const erased = await officerA().post(`/v1/chats/${chatId}/erase`, { expectedSnapshot: preview.body.data.snapshot, confirm: true },
      { 'Idempotency-Key': uniqueId('erase-') });
    expect(erased.status, erased.text).toBe(200);
    expect(countRows(h.dataDir, 'citizen_reports', 'chat_id = :chatId', { chatId })).toBe(0);
    expect(await entryFor('+971500000305')).toBeUndefined();
  });
});
