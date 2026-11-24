/**
 * An officer flags a chat's contact as a scammer: only the number goes to the phone watchlist (approved, with the officer's
 * reason), and the chat lists as a suspect while that number stays approved. Reserved fictional numbers and invented text only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type TestHarness } from '../helpers/harness.ts';
import { countRows } from '../helpers/db-read.ts';
import { envelope, recorded, uniqueId } from '../helpers/events.ts';

let h: TestHarness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

const officerA = () => h.http(h.tokens.officerA);
const NUMBER = '+44 7700 900123';
const E164 = '+447700900123';

async function inboundChat(text: string, phone?: string): Promise<string> {
  const event = recorded({ messageId: 1, text, ...(phone && { sender: { externalId: uniqueId('u-'), displayName: 'Contact', phone: { raw: phone } } }) });
  const res = await h.http(h.tokens.connector).post('/v1/ingest', envelope(h.accounts.intake, uniqueId('flag-'), event));
  expect(res.status, res.text).toBe(201);
  return res.body.data.chatId as string;
}
const flag = (chatId: string, body: unknown) => officerA().post(`/v1/chats/${chatId}/scammer-flags`, body);
const summaryOf = async (chatId: string) => (await officerA().get('/v1/chats')).body.data.chats.find((c: { id: string }) => c.id === chatId);
const entryFor = async (e164: string) => (await officerA().get('/v1/watchlist')).body.data.entries.find((e: { number: { e164: string } }) => e.number.e164 === e164);
const actionsOf = async (chatId: string, type: string) =>
  (await officerA().get(`/v1/chats/${chatId}/timeline`)).body.data.caseActions.filter((a: { type: string }) => a.type === type);

describe('scammer flags', () => {
  it('rejects a number that is not in international format and a chat with no message from the contact', async () => {
    const chatId = await inboundChat('Send the deposit first.');
    const local = await flag(chatId, { phone: '07700 900123', reason: 'Asked for an upfront deposit.' });
    expect(local.status).toBe(422);
    expect(local.body.error.code).toBe('phone_invalid');
    expect((await flag(chatId, { phone: NUMBER, reason: 'x' })).status).toBe(400);
    const registered = await officerA().post('/v1/chats', { ...h.accounts.officer, externalChatId: uniqueId('reg-'), displayLabel: 'Registered' });
    const empty = await flag(registered.body.data.chat.id, { phone: NUMBER, reason: 'Asked for an upfront deposit.' });
    expect(empty.status).toBe(404);
    expect(empty.body.error.code).toBe('message_not_found');
    expect(await summaryOf(chatId)).toMatchObject({ suspect: null });
    expect(countRows(h.dataDir, 'watchlist_entries', 'e164 = :e164', { e164: E164 })).toBe(0);
    expect(await flag('chat_missing', { phone: NUMBER, reason: 'Asked for an upfront deposit.' }).then(r => r.status)).toBe(404);
  });

  it('puts only the number on the watchlist, approved, makes the chat a suspect and matches every chat from that number', async () => {
    const earlier = await inboundChat('Hello again.', NUMBER);
    const chatId = await inboundChat('Pay the fee first, then I ship.');
    const res = await flag(chatId, { phone: NUMBER, reason: 'Asked for an upfront fee before shipping.' });
    expect(res.status, res.text).toBe(201);
    expect(res.body.data).toMatchObject({ created: true, entry: { status: 'approved', number: { e164: E164, display: NUMBER } } });
    const entry = await entryFor(E164);
    expect(entry.lastDecision).toMatchObject({ decision: 'approve', reason: 'Asked for an upfront fee before shipping.', officer: { displayName: expect.any(String) } });
    expect(entry.evidence).toEqual([expect.objectContaining({ chatId, origin: 'officer_flag', sourceRepresentation: NUMBER })]);
    expect(entry.canReview).toBe(true);

    const flagged = await summaryOf(chatId);
    expect(flagged.suspect).toMatchObject({ watchlistEntryId: entry.id, numberDisplay: NUMBER, flaggedBy: { displayName: expect.any(String) } });
    expect(flagged.watchlistMatches.map((m: { entryId: string }) => m.entryId)).toEqual([entry.id]);
    const [action] = await actionsOf(chatId, 'scammer_flagged');
    expect(action.detail).toEqual({ watchlistEntryId: entry.id });
    expect(JSON.stringify(action)).not.toContain('900123');

    // The other chat from the same number is matched, not made a suspect: only the officer's flagged chat moves.
    const other = await summaryOf(earlier);
    expect(other.suspect).toBeNull();
    expect(other.watchlistMatches.map((m: { entryId: string }) => m.entryId)).toEqual([entry.id]);
    expect(await actionsOf(earlier, 'watchlist_match')).toHaveLength(1);
    // A new chat from the number matches through the approved entry as before.
    const later = await inboundChat('Are you still selling?', NUMBER);
    expect((await summaryOf(later)).watchlistMatches.map((m: { entryId: string }) => m.entryId)).toEqual([entry.id]);

    // Flagging again changes nothing.
    const again = await flag(chatId, { phone: '00447700900123', reason: 'Same person again.' });
    expect(again.status).toBe(200);
    expect(again.body.data.created).toBe(false);
    expect(countRows(h.dataDir, 'watchlist_reviews', 'entry_id = :id', { id: entry.id })).toBe(1);
    expect(await actionsOf(chatId, 'scammer_flagged')).toHaveLength(1);
  });

  it('withdraws the suspect when the number is cleared on the watchlist, and a new flag approves it again', async () => {
    const number = '+44 7700 900456';
    const chatId = await inboundChat('Only bank transfer, today.');
    expect((await flag(chatId, { phone: number, reason: 'Pressed for a same-day transfer.' })).status).toBe(201);
    const entry = await entryFor('+447700900456');
    const cleared = await officerA().post(`/v1/watchlist/${entry.id}/review`, { decision: 'clear', reason: 'Wrong number entered.', expectedRevision: entry.revision });
    expect(cleared.status, cleared.text).toBe(200);
    expect((await summaryOf(chatId)).suspect).toBeNull();
    const reflag = await flag(chatId, { phone: number, reason: 'Confirmed by a second report.' });
    expect(reflag.status).toBe(201);
    expect(reflag.body.data.entry.status).toBe('approved');
    expect((await summaryOf(chatId)).suspect).toMatchObject({ watchlistEntryId: entry.id });
  });
});
