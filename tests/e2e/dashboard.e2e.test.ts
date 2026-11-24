/**
 * The reference dashboard end to end (brief build step 3; design sections 6 and 12). A real Mirsad instance from the
 * test harness, chats seeded over HTTP by the fixture connector, and the installed Microsoft Edge or Google Chrome driven
 * headless through playwright-core, with the officer token passed in the URL fragment. When neither browser can be
 * launched, every test is skipped with the reason.
 */
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReplyGenerator } from '../../src/replies/reply-generator.ts';
import type { Timeline } from '../../src/contract/schemas.ts';
import { provisionLiveOfficer } from '../../src/identity/officer-password.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { record as recordCaseAction } from '../../src/storage/repos/case-actions.ts';
import { envelope, recorded, uniqueId } from '../helpers/events.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';
import { Harness as TelegramHarness, LIVE_BASE_ENV, OWNER_ID, incoming, standIns } from '../helpers/telegram-live-harness.ts';

const BROWSER_CHANNELS = ['msedge', 'chrome'] as const;
const UI_TIMEOUT_MS = 15_000;
const OK = 200;
const CREATED = 201;
const RATE_LIMITED = { success: false, data: null, error: { code: 'rate_limited', message: 'Too many requests.' } };
const CONFIRMATION_NOTE = 'The merchant confirmed its payment page by phone.';

type Account = { source: 'telegram'; externalAccountId: string };
type InboxRegion = 'New inbound' | 'Open chats';

interface Dashboard {
  page: Page;
  /** Console errors and uncaught page errors, which include any Content-Security-Policy violation. */
  problems: string[];
}

let h: TestHarness;
let browser: Browser | null = null;
let skipReason = '';
const contexts: BrowserContext[] = [];

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'unknown error';
}

async function launchInstalledBrowser(): Promise<Browser | null> {
  const failures: string[] = [];
  for (const channel of BROWSER_CHANNELS) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (error) {
      failures.push(`${channel}: ${firstLine(error)}`);
    }
  }
  skipReason = `Skipped: neither Microsoft Edge nor Google Chrome could be launched by playwright-core (${failures.join('; ')}).`;
  return null;
}

beforeAll(async () => {
  h = await startHarness();
  browser = await launchInstalledBrowser();
});

afterAll(async () => {
  await browser?.close();
  await h.close();
});

beforeEach((context) => {
  // Each browser scenario gets its own request-limit window in the shared, frozen-clock fixture.
  h.clock.advance(60_000);
  if (!browser) context.skip(skipReason);
});

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

interface IngestedMessage {
  chatId: string;
  messageId: string;
}

/** One message posted through the fixture connector; the conversation's first message creates the chat. */
async function ingestMessage(account: Account, externalChatId: string, label: string, messageId: number, text: string, direction: 'incoming' | 'outgoing' = 'incoming'): Promise<IngestedMessage> {
  const sender = direction === 'incoming' ? { externalId: `tg-user-${externalChatId}`, displayName: label } : undefined;
  const event = recorded({ messageId, direction, text, sender });
  const res = await h.http(h.tokens.connector).post('/v1/ingest', envelope(account, externalChatId, event, label));
  expect(res.status, res.text).toBe(CREATED);
  return { chatId: res.body.data.chatId as string, messageId: res.body.data.messageId as string };
}

/** A chat created by its first message through the fixture connector; an incoming first message enters New inbound. */
async function seedChat(account: Account, label: string, text: string, direction: 'incoming' | 'outgoing' = 'incoming') {
  const externalChatId = uniqueId('chat-');
  return { ...(await ingestMessage(account, externalChatId, label, 1, text, direction)), externalChatId };
}

async function timelineOf(chatId: string): Promise<Timeline> {
  const res = await h.http(h.tokens.officerA).get(`/v1/chats/${chatId}/timeline`);
  expect(res.status, res.text).toBe(OK);
  return res.body.data as Timeline;
}

/** Opens the dashboard in a fresh browser context, signed in through the #token= fragment. */
async function openDashboard(token: string, baseUrl = h.baseUrl): Promise<Dashboard> {
  const context = await browser!.newContext();
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(UI_TIMEOUT_MS);
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  const response = await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`);
  expect(response?.status()).toBe(OK);
  await page.getByRole('heading', { name: 'New inbound', exact: true }).waitFor();
  return { page, problems };
}

function inboxItem(page: Page, region: InboxRegion, label: string): Locator {
  return page
    .getByRole('region', { name: region, exact: true })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: label, exact: true }) });
}

async function openChat(page: Page, label: string): Promise<void> {
  await page.locator('#inbox').getByRole('link', { name: label, exact: true }).click();
  await page.locator('#chat-header').getByRole('heading', { name: label, exact: true }).waitFor();
}

/** The page's location as the callback below sees it; this test project has no DOM types. */
type PageGlobal = { location: { hash: string } };

async function openSettings(page: Page): Promise<void> {
  await page.locator('#open-settings').click();
  await page.getByRole('dialog').waitFor();
}

async function openEvidence(page: Page): Promise<void> {
  await page.locator('#open-evidence').click();
  await page.locator('#side-panel').waitFor();
}

async function openMessageDetails(message: Locator): Promise<void> {
  const details = message.locator('details.message-details');
  await details.waitFor();
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
}

/** What pasting a sign-in link into the address bar of an open tab does: only the fragment changes. */
async function pasteTokenLink(page: Page, token: string): Promise<void> {
  await page.evaluate((fragment) => {
    (globalThis as unknown as PageGlobal).location.hash = fragment;
  }, `#token=${encodeURIComponent(token)}`);
}

const replyBox = (page: Page): Locator => page.getByRole('textbox', { name: 'Reply', exact: true });
const button = (page: Page, name: string): Locator => page.getByRole('button', { name, exact: true });
const outgoingEntries = (page: Page): Locator => page.locator('#timeline article[data-direction="outgoing"]');

describe('reference dashboard', () => {
  it('requires a new confirmation when the selected history changes after the erasure preview', async () => {
    const label = 'Sample silver lamp';
    const target = await seedChat(h.accounts.intake, label, 'May I inspect the lamp?');
    await h.drain();
    const { page } = await openDashboard(h.tokens.officerA);
    await openChat(page, label);
    await button(page, 'Reset this chat').click();
    const dialog = page.getByRole('dialog', { name: 'Reset this chat' });
    const erase = dialog.getByRole('button', { name: 'Erase this chat' });
    await dialog.getByText('One local conversation selected.').waitFor();
    await ingestMessage(h.accounts.intake, target.externalChatId, label, 2, 'A new detail arrived.');
    await h.drain();
    await erase.click();
    await dialog.getByText(/history changed.*reopen/i).waitFor();
    expect(await erase.isDisabled()).toBe(true);
    expect(await dialog.getByRole('button', { name: 'Delete from Telegram for both' }).isDisabled()).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('#timeline').getByText('A new detail arrived.').waitFor();
    expect((await timelineOf(target.chatId)).messages.length).toBe(2);
  });

  it('resets only the named chat after confirmation and erases the remaining local inbox only after typing ERASE', async () => {
    const instance = await startHarness();
    try {
      const labels = ['Sample blue lamps', 'Sample green lamps', 'Sample glass lamps'] as const;
      for (const label of labels) {
        const event = recorded({ messageId: 11, text: 'Is the lamp available?', direction: 'incoming' });
        const res = await instance.http(instance.tokens.connector).post('/v1/ingest',
          envelope(instance.accounts.intake, uniqueId('erase-ui-'), event, label));
        expect(res.status).toBe(CREATED);
      }
      await instance.drain();
      const { page } = await openDashboard(instance.tokens.officerA, instance.baseUrl);
      const posts: string[] = [];
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/erase')) posts.push(request.url());
      });
      await openChat(page, labels[0]!);
      await button(page, 'Take over').click();
      await replyBox(page).fill('An unsent local draft.');
      const otherTab = (await openDashboard(instance.tokens.officerA, instance.baseUrl)).page;
      await openChat(otherTab, labels[0]);
      await replyBox(otherTab).fill('Another unsent draft.');
      await openMessageDetails(otherTab.locator('#timeline article[data-direction="incoming"]').first());
      await otherTab.getByRole('button', { name: /Enlarge the Mirsad-rendered capture/ }).first().click();
      await otherTab.locator('#capture-dialog').waitFor();
      const reset = button(page, 'Reset this chat');
      expect(await reset.count()).toBe(1);
      await reset.click();
      const confirm = page.getByRole('dialog', { name: 'Reset this chat' });
      await confirm.getByText(labels[0]!, { exact: true }).waitFor();
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      expect(posts).toHaveLength(0);
      await reset.click();
      await confirm.getByRole('button', { name: 'Erase this chat' }).click();
      await page.locator('#notice').filter({ hasText: /erased/i }).waitFor();
      expect(new URL(page.url()).hash).toBe('#/');
      expect(await page.locator('#chat-tools').isHidden()).toBe(true);
      expect(await page.locator('#composer-text').inputValue()).toBe('');
      expect(await page.locator('#capture-dialog-image').getAttribute('src')).toBeNull();
      expect(await page.getByRole('link', { name: labels[0], exact: true }).count()).toBe(0);
      await otherTab.locator('#capture-dialog').waitFor({ state: 'hidden' });
      expect(await otherTab.locator('#composer-text').inputValue()).toBe('');
      expect(await otherTab.locator('#capture-dialog-image').getAttribute('src')).toBeNull();
      await page.getByRole('link', { name: labels[1], exact: true }).waitFor();
      expect(posts).toHaveLength(1);
      await openChat(page, labels[2]!);
      await openSettings(page);
      await button(page, 'Erase entire inbox').click();
      const bulk = page.getByRole('dialog', { name: 'Erase entire inbox' });
      await bulk.getByText(/2 local conversations/i).waitFor();
      const erase = bulk.getByRole('button', { name: 'Erase all 2 chats' });
      expect(await erase.isDisabled()).toBe(true);
      await bulk.getByLabel('Type ERASE to confirm').fill('erase');
      expect(await erase.isDisabled()).toBe(true);
      const remote = bulk.getByRole('button', { name: 'Delete from Telegram for both' });
      expect(await remote.isDisabled()).toBe(true);
      expect(posts).toHaveLength(1);
      await bulk.getByLabel('Type ERASE to confirm').fill('ERASE');
      const keys: string[] = [];
      const chatId = decodeURIComponent(new URL(page.url()).hash.split('/').at(-1)!);
      await page.route('**/v1/inbox/erase-telegram', async route => {
        keys.push(route.request().headers()['idempotency-key']!);
        expect(route.request().postDataJSON()).toEqual({ confirm: true, expectedSnapshot: expect.stringMatching(/^[a-f\d]{64}$/) });
        const waiting = keys.length === 1;
        const counts = { total: 3, removed: 1, skipped: 1, failed: 0, uncertain: waiting ? 0 : 1, pending: waiting ? 1 : 0 };
        await route.fulfill({ json: { success: true, data: { status: waiting ? 'in_progress' : 'completed',
          ...counts, excluded: { expired: 1, unsupported: 0, unverified: 0, rights: 0 }, manualHistoryMayRemain: true,
          remainingChats: [{ chatId, ...counts }] } } });
      });
      await remote.click();
      await bulk.getByText(/Check Telegram status for the final result/).waitFor();
      expect(await erase.isDisabled()).toBe(true);
      expect(posts).toHaveLength(1);
      await bulk.getByRole('button', { name: 'Check Telegram status' }).click();
      const receipt = bulk.getByRole('status', { name: 'Telegram deletion result' });
      await receipt.getByText('1 skipped, 0 failed, 1 unconfirmed, 0 pending.', { exact: true }).waitFor();
      await receipt.getByText(/Mirsad never saw/).waitFor();
      expect(await receipt.getByRole('link', { name: labels[2] }).getAttribute('href')).toBe(`#/chats/${chatId}`);
      expect(keys[1]).toBe(keys[0]);
      expect(posts).toHaveLength(1);
      await erase.click();
      await page.locator('#notice').filter({ hasText: /2.*erased|erased.*2/i }).waitFor();
      expect(await page.locator('#notice').innerText()).toContain('1 unconfirmed');
      expect(await page.locator('#inbox .chat-link').count()).toBe(0);
      expect(await page.locator('#chat-tools').isHidden()).toBe(true);
      expect(posts).toHaveLength(2);
    } finally { await instance.close(); }
  });

  it('opens a verified conversation after dispatching its phone number and keeps the number and briefing out of the URL', async () => {
    const contact = 6000000941;
    const number = '+44 7700 900143';
    const brief = 'Ask about the delivery schedule.';
    const stand = standIns();
    const live = await TelegramHarness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact) }, stand);
    try {
      const ownCard = incoming(contact, '', stand.clock.now().getTime());
      const incomingMessage = ownCard.business_message as Record<string, unknown>;
      delete incomingMessage.text;
      incomingMessage.contact = { phone_number: number, user_id: contact, first_name: 'Test' };
      await live.deliver(ownCard);
      await live.receive(contact, 'I have a parcel available.');
      const chat = (await live.chatFor(contact))!;
      const { page } = await openDashboard(live.data.token, live.url);
      const open = button(page, 'Dispatch a number');
      expect(await open.count()).toBe(1);
      await open.click();
      const dialog = page.getByRole('dialog', { name: 'Dispatch a number' });
      await dialog.getByLabel('Phone number').fill(number);
      await dialog.getByLabel('Officer briefing').fill(brief);
      expect(await dialog.getByText(/already agreed/).count()).toBe(0);
      await dialog.getByRole('button', { name: 'Dispatch', exact: true }).click();
      await dialog.getByRole('link', { name: 'Open conversation' }).click();
      await page.locator('#chat-header').getByRole('heading', { name: chat.displayLabel }).waitFor();
      expect(new URL(page.url()).hash).toBe(`#/chats/${chat.id}`);
      expect((await live.chatFor(contact))!.aiMode).toBe('ai_active');
      expect(await live.caseActionsOf(contact, 'telegram_dispatch_approved')).toHaveLength(1);
      expect(await live.caseActionsOf(contact, 'telegram_dispatch_permission_recorded')).toHaveLength(0);
    } finally { await live.stop(); }
  });

  it('offers a manual first message for an unknown number and retried phone dispatch uses one idempotency key', async () => {
    const { page } = await openDashboard(h.tokens.officerA);
    await page.setViewportSize({ width: 320, height: 650 });
    const open = button(page, 'Dispatch a number');
    expect(await open.count()).toBe(1);
    await open.click();
    const dialog = page.getByRole('dialog', { name: 'Dispatch a number' });
    const phone = '+44 7700 900145';
    const brief = 'Confirm the parcel fee.';
    await dialog.getByLabel('Phone number').fill(phone);
    await dialog.getByLabel('Officer briefing').fill(brief);
    const keys: string[] = [];
    await page.route('**/v1/dispatches/by-phone', async route => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      expect(route.request().postDataJSON()).toEqual({ phoneNumber: phone, officerContext: brief, participantPermissionRecorded: true });
      if (keys.length === 1) await route.abort('failed');
      else await route.continue();
    });
    const submit = dialog.getByRole('button', { name: 'Dispatch', exact: true });
    await submit.click();
    await dialog.getByRole('status').filter({ hasText: /could not be reached/i }).waitFor();
    await submit.click();
    await dialog.getByRole('button', { name: 'Draft first message' }).click();
    expect(keys.length).toBe(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    const opener = page.getByRole('dialog', { name: 'Draft a first message' });
    expect(await opener.getByLabel('Officer briefing').inputValue()).toBe(brief);
    const text = opener.getByLabel('Opening message draft');
    const telegram = opener.getByRole('button', { name: 'Open draft in Telegram' });
    const edited = 'Could I view the parcel on Friday?';
    const externalRequests: string[] = [];
    await page.context().route('https://t.me/**', route => {
      externalRequests.push(route.request().method());
      return route.abort();
    });
    type DraftWindow = { open: (...args: string[]) => null; handoffs: string[][] };
    await page.evaluate(() => {
      const appWindow = globalThis as unknown as DraftWindow;
      appWindow.handoffs = [];
      appWindow.open = (...args) => { appWindow.handoffs.push(args); return null; };
    });
    await opener.getByLabel('Officer briefing').fill('');
    await text.fill(edited);
    expect(await page.evaluate(() => (globalThis as unknown as DraftWindow).handoffs.length)).toBe(0);
    await telegram.click();
    const [handoff] = await page.evaluate(() => (globalThis as unknown as DraftWindow).handoffs);
    expect(handoff?.slice(1)).toEqual(['_blank', 'noopener,noreferrer']);
    const url = new URL(handoff![0]!);
    expect(url.origin).toBe('https://t.me');
    expect(url.pathname).toBe('/+447700900145');
    expect([...url.searchParams]).toEqual([['text', edited]]);
    expect(externalRequests).toHaveLength(0);
    expect(await opener.getByRole('button', { name: 'Copy draft' }).isEnabled()).toBe(true);
    await opener.getByLabel('Officer briefing').fill(brief);
    await opener.getByRole('button', { name: 'Generate draft' }).click();
    await expect.poll(() => text.inputValue()).not.toBe(edited);
    expect(await text.inputValue()).toBeTruthy();
    expect(new URL(page.url()).search).toBe('');
    expect(new URL(page.url()).hash).toBe('');
  });

  it('links a lower-concern meeting to its evidence and starts the next test with an empty conversation', async () => {
    const contact = 6000000924;
    const stand = standIns();
    stand.generator.replyNext('Could we meet in person to inspect the lamp?', 'Thanks, that works.');
    const live = await TelegramHarness.start({
      ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true',
    }, stand);
    try {
      await live.receive(contact, 'I have a secondhand lamp for sale.');
      await live.app.drain();
      const meeting = await live.receive(contact, 'Yes, we can meet tomorrow at 4 pm at the Sample Market entrance.');
      await live.app.drain();
      const chat = (await live.chatFor(contact))!;
      const { page, problems } = await openDashboard(live.data.token, live.url);
      const filter = page.getByRole('button', { name: /^Lower concern/ });
      await filter.click();
      await openChat(page, chat.displayLabel);
      await openEvidence(page);
      const cited = page.locator('#meeting-sources').getByRole('link', { name: 'Time', exact: true });
      await cited.click();
      await page.locator(`#message-${meeting.id}.focused`).waitFor();

      const { startFreshChatTest } = await import('../../src/services/chat-test-session.ts');
      const officer = (await live.call('GET', '/v1/me')).data.principal;
      const db = openDatabase(path.join(live.data.dataDir, DATABASE_FILE), { clock: stand.clock });
      try { db.transaction(tx => startFreshChatTest(tx, chat.id, officer.id)); } finally { db.close(); }
      await page.goto(`${live.url}/#/chats/${chat.id}`);
      await page.reload();
      await page.locator('#chat-header').getByRole('heading', { name: chat.displayLabel }).waitFor();
      expect(await page.locator('#timeline [data-kind="message"]').count()).toBe(0);
      await openEvidence(page);
      await page.locator('#previous-conversation').click();
      await page.locator(`#message-${meeting.id}`).waitFor();
      await page.locator('#current-conversation').click();
      await expect.poll(() => page.locator('#timeline [data-kind="message"]').count()).toBe(0);
      await page.locator('#nav-inbox').click();
      await filter.click();
      const previousTests = page.getByRole('region', { name: 'Previous tests', exact: true });
      const archivedLink = previousTests.getByRole('link', { name: chat.displayLabel, exact: true });
      await archivedLink.click();
      await page.locator(`#message-${meeting.id}.focused`).waitFor();
      stand.clock.advance(2_000);
      await live.receive(contact, 'Is anyone here?');
      await live.app.drain();
      expect(stand.generator.histories.at(-1)).toEqual([{ from: 'contact', text: 'Is anyone here?' }]);
      expect(problems).toEqual([]);
    } finally { await live.stop(); }
  });

  it('opens a phone conversation in place of its queue and returns to the inbox', async () => {
    const label = 'Phone Layout Contact';
    const chat = await seedChat(h.accounts.intake, label, 'Can you confirm the delivery time?');
    const { page } = await openDashboard(h.tokens.officerA);
    await page.setViewportSize({ width: 390, height: 844 });
    const queue = page.locator('#inbox');
    const conversation = page.locator('#chat-panel');
    expect(await queue.isVisible()).toBe(true);
    expect(await conversation.isVisible()).toBe(false);
    await openChat(page, label);
    expect(await queue.isVisible()).toBe(false);
    expect(await page.locator('#back-to-inbox:focus').count()).toBe(1);
    const message = page.locator(`#message-${chat.messageId} .message-text`);
    await message.waitFor();
    const rect = await message.boundingBox();
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThan(844);
    await page.locator('#open-evidence').click();
    await page.locator('#side-panel').waitFor();
    await page.locator('#close-evidence').click();
    await page.locator('#back-to-inbox').click();
    await queue.waitFor();
    expect(await conversation.isVisible()).toBe(false);
    const returnedLink = queue.getByRole('link', { name: label, exact: true });
    expect(await returnedLink.isVisible()).toBe(true);
    expect(await returnedLink.evaluate(node => node.matches(':focus'))).toBe(true);
  });

  it('returns from evidence to the requested message when navigating mobile browser history inside a case', async () => {
    const label = 'History Navigation Contact';
    const first = await seedChat(h.accounts.intake, label, 'Is collection available?');
    const second = await ingestMessage(h.accounts.intake, first.externalChatId, label, 2, 'What time would suit you?');
    const { page } = await openDashboard(h.tokens.officerA);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const message of [first, second]) {
      await page.evaluate(hash => { (globalThis as unknown as PageGlobal).location.hash = hash; },
        `#/chats/${first.chatId}/messages/${message.messageId}`);
      await page.locator(`#message-${message.messageId}.focused`).waitFor();
    }
    await openEvidence(page);
    await page.goBack();
    const original = page.locator(`#message-${first.messageId}.focused`);
    await original.waitFor({ state: 'attached' });
    expect(await page.locator('#side-panel').isVisible()).toBe(false);
    expect(await original.isVisible()).toBe(true);
    expect(await original.evaluate(element => element.matches(':focus'))).toBe(true);
  });

  it('shows case evidence on demand and keeps each message compact until details are requested', async () => {
    const label = 'Desktop Layout Contact';
    const chat = await seedChat(h.accounts.intake, label, 'Can you confirm the collection time?');
    await h.drain();
    const { page } = await openDashboard(h.tokens.officerA);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openChat(page, label);
    const panel = page.locator('#side-panel');
    expect(await panel.isVisible()).toBe(false);
    const message = page.locator(`#message-${chat.messageId}`);
    await message.getByText('Can you confirm the collection time?', { exact: true }).waitFor();
    expect(await message.locator('.facts').isVisible()).toBe(false);
    await message.getByText('Message details', { exact: true }).click();
    await message.locator('.facts').waitFor();
    await message.locator('figure.capture[data-state="loaded"]').waitFor();
    await page.locator('#open-evidence').click();
    await panel.getByRole('heading', { name: 'Case log' }).waitFor();
    expect(await panel.getByLabel('Source note').isVisible()).toBe(false);
    await panel.getByText('Add merchant confirmation', { exact: true }).click();
    await panel.getByLabel('Source note').waitFor();
    await panel.getByLabel('Source note').press('Escape');
    expect(await panel.isVisible()).toBe(false);
    expect(await page.locator('#open-evidence:focus').count()).toBe(1);
  });

  it('opens on password sign-in when a tab previously used a demo officer token', async () => {
    const context = await browser!.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(h.baseUrl);
    await page.evaluate((oldToken) => {
      globalThis.sessionStorage.setItem('mirsad.officerToken', oldToken);
    }, h.tokens.officerA);
    await page.reload();
    const username = page.getByLabel('Username', { exact: true });
    const password = page.getByLabel('Password', { exact: true });
    await username.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await username.getAttribute('autocomplete')).toBe('username');
    expect(await password.getAttribute('type')).toBe('password');
    expect(await password.getAttribute('autocomplete')).toBe('current-password');
    expect(await page.locator('#workspace').isVisible()).toBe(false);
    expect(await page.getByLabel('Officer token').count()).toBe(0);
    expect(await page.evaluate("sessionStorage.getItem('mirsad.officerToken') === null")).toBe(true);
  });

  it('signs in with a password, restores the live-account inbox after reload and revokes the session on sign-out', async () => {
    const contact = 6000000991;
    const stand = standIns();
    const live = await TelegramHarness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact) }, stand);
    const username = 'test.officer';
    const password = uniqueId('synthetic-password-');
    try {
      const db = openDatabase(path.join(live.data.dataDir, DATABASE_FILE));
      try {
        await provisionLiveOfficer(db, username, password);
      } finally {
        db.close();
      }
      await live.deliver(incoming(contact, 'Checking in.', stand.clock.now().getTime()));
      const chat = (await live.chatFor(contact))!;
      const context = await browser!.newContext();
      contexts.push(context);
      const page = await context.newPage();
      page.setDefaultTimeout(UI_TIMEOUT_MS);
      await page.goto(live.url);
      const passwordInput = page.getByLabel('Password', { exact: true });
      await page.getByLabel('Username', { exact: true }).fill(username);
      await passwordInput.fill('incorrect-password');
      await button(page, 'Sign in').click();
      await page.locator('#signin-message').filter({ hasText: 'Incorrect username or password' }).waitFor();
      expect(await passwordInput.inputValue()).toBe('');
      await passwordInput.fill(password);
      await button(page, 'Sign in').click();
      const contactLink = page.getByRole('link', { name: chat.displayLabel, exact: true });
      await contactLink.waitFor();
      await page.reload();
      await contactLink.waitFor();
      const logoutRequest = page.waitForRequest('**/v1/auth/logout');
      const logoutResponse = page.waitForResponse('**/v1/auth/logout');
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route('**/v1/auth/logout', async (route) => { await held; await route.continue(); });
      await button(page, 'Sign out').click();
      try {
        await passwordInput.waitFor();
        expect(await page.locator('#workspace').isVisible()).toBe(false);
      } finally { release(); }
      const request = await logoutRequest;
      expect(request.method()).toBe('POST');
      expect((await logoutResponse).status()).toBe(OK);
      const authorization = await request.headerValue('authorization');
      expect(authorization?.startsWith('Bearer session_')).toBe(true);
      const previousSession = await fetch(`${live.url}/v1/me`, { headers: { authorization: authorization! } });
      expect(previousSession.status).toBe(401);
      await page.reload();
      await passwordInput.waitFor();
    } finally { await live.stop(); }
  });

  it('requires a new password before opening the portal for a temporary officer login', async () => {
    const live = await TelegramHarness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: '6000000992' }, standIns());
    const username = 'test.first.login';
    const temporary = uniqueId('synthetic-temporary-');
    const replacement = uniqueId('synthetic-replacement-');
    try {
      const db = openDatabase(path.join(live.data.dataDir, DATABASE_FILE));
      try { await provisionLiveOfficer(db, username, temporary, { temporary: true }); }
      finally { db.close(); }
      const context = await browser!.newContext();
      contexts.push(context);
      const page = await context.newPage();
      page.setDefaultTimeout(UI_TIMEOUT_MS);
      await page.goto(live.url);
      await page.getByLabel('Username', { exact: true }).fill(username);
      await page.getByLabel('Password', { exact: true }).fill(temporary);
      await button(page, 'Sign in').click();
      const newPassword = page.getByLabel('New password', { exact: true });
      const confirm = page.getByLabel('Confirm new password', { exact: true });
      const submit = button(page, 'Save password and sign in');
      await newPassword.waitFor();
      expect(await page.locator('#workspace').isVisible()).toBe(false);
      expect(await page.evaluate("sessionStorage.getItem('mirsad.officerSession.v2')")).toBeNull();
      await newPassword.fill(temporary);
      await confirm.fill(temporary);
      await submit.click();
      await page.getByText('Choose a password different from your temporary password.').waitFor();
      await newPassword.fill(replacement);
      await submit.click();
      await page.getByText('The new passwords do not match.').waitFor();
      await confirm.fill(replacement);
      await submit.click();
      await button(page, 'Sign out').waitFor();
      expect(await newPassword.inputValue()).toBe('');
      expect(await confirm.inputValue()).toBe('');
    } finally { await live.stop(); }
  });

  it('reloads the saved reply prompt from Settings and reports the result without showing its contents', async () => {
    const live = await TelegramHarness.start({ ...LIVE_BASE_ENV }, standIns());
    try {
      const { page } = await openDashboard(live.data.token, live.url);
      const calls: string[] = [];
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/v1/telegram/reply-prompt/reload', async route => {
        calls.push(route.request().method());
        expect(route.request().postData()).toBeNull();
        if (calls.length === 1) await held;
        const invalid = calls.length === 3;
        await route.fulfill({ status: invalid ? 422 : 200, json: invalid
          ? { success: false, error: { code: 'reply_prompt_unavailable', message: 'synthetic private prompt fragment' } }
          : { success: true, data: { version: '7'.repeat(64), changed: calls.length === 1 } } });
      });
      await openSettings(page);
      const dialog = page.getByRole('dialog', { name: 'Telegram settings' });
      const reload = dialog.getByRole('button', { name: 'Reload Ali’s prompt', exact: true });
      await reload.waitFor({ timeout: 3_000 });
      await reload.focus();
      await reload.press('Enter');
      try {
        await dialog.getByRole('status').filter({ hasText: 'Loading the saved prompt' }).waitFor();
        expect(await reload.isDisabled()).toBe(true);
        expect(await reload.getAttribute('aria-busy')).toBe('true');
      } finally { release(); }
      const status = dialog.getByRole('status');
      await status.filter({ hasText: 'Saved prompt loaded. Ali will use it for the next reply.' }).waitFor();
      await reload.click();
      await status.filter({ hasText: 'Ali is already using the saved prompt.' }).waitFor();
      await reload.click();
      await status.filter({ hasText: 'Check the saved prompt file' }).waitFor();
      expect(await reload.getAttribute('aria-busy')).toBe('false');
      expect(await dialog.textContent()).not.toContain('synthetic private prompt fragment');
      expect(await reload.isEnabled()).toBe(true);
      expect(calls).toEqual(['POST', 'POST', 'POST']);
    } finally { await live.stop(); }
  });

  it('turns all-DM replies on and off and shows the saved setting after reloading', async () => {
    const live = await TelegramHarness.start({
      ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST-ALL-DMS',
      TELEGRAM_APPROVED_CHAT_IDS: '6000000992',
    }, standIns());
    try {
      const { page } = await openDashboard(live.data.token, live.url);
      await openSettings(page);
      const toggle = page.getByRole('switch', { name: 'Auto-reply to every Telegram DM' });
      await toggle.waitFor();
      await page.getByText('Ali currently replies only to approved chats.').waitFor();
      expect(await toggle.getAttribute('aria-checked')).toBe('false');
      await toggle.click();
      await page.getByText('Ali can reply in chats with recorded consent.').waitFor();
      expect(await toggle.getAttribute('aria-checked')).toBe('true');
      await page.reload();
      await openSettings(page);
      await page.getByText('Ali can reply in chats with recorded consent.').waitFor();
      await toggle.click();
      await page.getByText('Automatic replies are paused. Incoming DMs still appear in the inbox.').waitFor();
      expect(await toggle.getAttribute('aria-checked')).toBe('false');
    } finally { await live.stop(); }
  });

  it('saves Test mode and stops automatic dispatch when the officer turns it off', async () => {
    const live = await TelegramHarness.start({
      ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST-ALL-DMS',
    }, standIns());
    try {
      await live.call('POST', '/v1/telegram/dm-replies', { enabled: true });
      const { page } = await openDashboard(live.data.token, live.url);
      await openSettings(page);
      const replies = page.getByRole('switch', { name: 'Auto-reply to every Telegram DM' });
      const testMode = page.getByRole('switch', { name: 'Test mode', exact: true });
      const offHint = page.getByText(/new chats wait for (manual )?dispatch/i);
      const onHint = page.getByText(/new and returning chats become AI active automatically/i);
      await testMode.waitFor();
      await offHint.waitFor();
      expect(await testMode.getAttribute('aria-checked')).toBe('false');
      await testMode.click();
      await onHint.waitFor();
      expect(await testMode.getAttribute('aria-checked')).toBe('true');
      expect((await live.call('GET', '/v1/telegram/consent-prompt')).data.enabled).toBe(false);
      await page.reload();
      await openSettings(page);
      await onHint.waitFor();
      expect(await testMode.getAttribute('aria-checked')).toBe('true');
      expect(await replies.getAttribute('aria-checked')).toBe('true');
      await testMode.focus();
      await testMode.press('Space');
      await offHint.waitFor();
      expect(await testMode.getAttribute('aria-checked')).toBe('false');
      expect((await live.call('GET', '/v1/telegram/consent-prompt')).data).toMatchObject({ enabled: true, manualDispatchOnly: true });
      await page.getByText(/Dispatch records the participant’s existing permission/i).waitFor();
      expect((await live.call('GET', '/v1/telegram/dm-replies')).data.enabled).toBe(true);
      live.stand.clock.advance(1_000);
      await live.receive(6000000997, 'Is the table available?');
      await live.app.drain();
      expect(live.stand.sender.to(6000000997)).toHaveLength(0);
      expect(live.stand.generator.histories).toHaveLength(0);
      expect((await live.chatFor(6000000997))?.aiMode).toBe('not_started');
    } finally { await live.stop(); }
  });

  it('shows AI active in the inbox and chat header when the officer sends the first Telegram DM in Test mode', async () => {
    const contact = 6000000941;
    const stand = standIns();
    const live = await TelegramHarness.start({ ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private',
      TELEGRAM_ALL_CHATS_REFERENCE: 'TEST', TELEGRAM_APPROVED_CHAT_IDS: String(contact) }, stand);
    try {
      await live.call('POST', '/v1/telegram/dm-replies', { enabled: true });
      await live.call('POST', '/v1/telegram/consent-prompt', { enabled: false });
      const { page } = await openDashboard(live.data.token, live.url);
      stand.clock.advance(1_000);
      await live.deliver(incoming(contact, 'Is the bookshelf still available?', stand.clock.now().getTime(), { fromId: OWNER_ID }));
      stand.clock.advance(3_000);
      await live.app.drain();
      const chat = (await live.chatFor(contact))!;
      const row = inboxItem(page, 'Open chats', chat.displayLabel);
      await row.waitFor();
      await expect.poll(() => row.locator('.ai-mode').textContent()).toBe('AI active');
      await openChat(page, chat.displayLabel);
      await page.locator('#chat-header').getByText('AI active', { exact: true }).waitFor();
      expect(stand.generator.histories).toHaveLength(0);
      expect(stand.sender.sent).toHaveLength(0);
    } finally { await live.stop(); }
  });

  it('confirms the selected Telegram chat and includes its briefing with one inbox Dispatch click', async () => {
    const chosen = 6000000977;
    const unrelated = 6000000978;
    const stand = standIns();
    const live = await TelegramHarness.start({ ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private',
      TELEGRAM_ALL_CHATS_REFERENCE: 'TEST', TELEGRAM_APPROVED_CHAT_IDS: '6000000900' }, stand);
    try {
      await live.call('POST', '/v1/telegram/dm-replies', { enabled: true });
      await live.call('POST', '/v1/telegram/consent-prompt', { enabled: false });
      await live.receive(chosen, 'Are you free tomorrow?');
      await live.receive(unrelated, 'Do you still want the lamp?');
      const chat = (await live.chatFor(chosen))!;
      const { page } = await openDashboard(live.data.token, live.url);
      await page.getByRole('checkbox', { name: 'Select ' + chat.displayLabel, exact: true }).check();
      await page.getByText('Dispatch briefing', { exact: true }).click();
      await page.locator('#dispatch-brief-text').fill('Ask about the time.');
      expect(await page.locator('#inbox').getByText(/already agreed/).count()).toBe(0);
      expect(await live.caseActionsOf(chosen, 'telegram_dispatch_permission_recorded')).toHaveLength(0);
      const posted = page.waitForResponse(res => new URL(res.url()).pathname === '/v1/dispatches' && res.request().method() === 'POST');
      await page.locator('#dispatch-button').click();
      const response = await posted;
      expect(response.ok()).toBe(true);
      expect(response.request().postDataJSON()).toMatchObject({ chatIds: [chat.id], replyAgain: true,
        participantPermissionRecorded: true, officerContext: 'Ask about the time.' });
      expect(await page.locator('#chat-dispatch-dialog').isVisible()).toBe(false);
      expect(await live.caseActionsOf(chosen, 'telegram_dispatch_permission_recorded')).toHaveLength(1);
      expect(await live.caseActionsOf(unrelated, 'telegram_dispatch_permission_recorded')).toHaveLength(0);
    } finally { await live.stop(); }
  });

  it('dispatches the existing first DM in Test mode with one officer confirmation and leaves an unrelated chat silent', async () => {
    const chosen = 6000000932;
    const unrelated = 6000000933;
    const first = 'Would you like to look at the desk tomorrow?';
    const stand = standIns();
    stand.generator.replyNext('What time would work for you?');
    const live = await TelegramHarness.start({ ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private',
      TELEGRAM_ALL_CHATS_REFERENCE: 'TEST', TELEGRAM_APPROVED_CHAT_IDS: '6000000900' }, stand);
    try {
      await live.call('POST', '/v1/telegram/dm-replies', { enabled: true });
      const { page } = await openDashboard(live.data.token, live.url);
      await openSettings(page);
      await page.getByRole('switch', { name: 'Test mode', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Telegram settings' });
      await settings.getByRole('switch', { name: 'Test mode', checked: true }).waitFor();
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
      await live.receive(chosen, first);
      await live.receive(unrelated, 'Is the blue lamp the right size?');
      await live.app.drain();
      expect(stand.generator.histories).toHaveLength(0);
      expect(stand.sender.sent).toHaveLength(0);
      const chat = (await live.chatFor(chosen))!;
      expect(chat.aiMode).toBe('ai_active');
      expect((await live.chatFor(unrelated))?.aiMode).toBe('ai_active');
      await openChat(page, chat.displayLabel);
      await page.locator('#chat-header').getByText('AI active', { exact: true }).waitFor();
      expect(await page.locator('#chat-header').getByText(/already agreed/).count()).toBe(0);
      const requests: unknown[] = [];
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/dispatches') requests.push(request.postDataJSON());
      });
      const dispatch = page.locator('#open-chat-dispatch');
      await dispatch.click();
      await expect.poll(() => stand.sender.to(chosen).length).toBe(1);
      expect(requests).toEqual([{ chatIds: [chat.id], participantPermissionRecorded: true, replyAgain: true,
        replyToMessageId: expect.any(String), replyToHeadPosition: expect.any(Number) }]);
      expect(await page.locator('#chat-dispatch-dialog').isVisible()).toBe(false);
      await page.locator('#chat-header').getByText('Approved for AI replies', { exact: true }).waitFor();
      expect(stand.generator.histories).toEqual([[{ from: 'contact', text: first }]]);
      expect(stand.sender.to(unrelated)).toHaveLength(0);
      await live.call('POST', '/v1/telegram/consent-prompt', { enabled: true, manualDispatchOnly: true });
      await button(page, 'Send follow-up').click();
      await expect.poll(() => stand.sender.to(chosen).length).toBe(2);
      expect(requests).toHaveLength(2);
      expect(await live.caseActionsOf(chosen, 'telegram_dispatch_permission_recorded')).toHaveLength(1);
      expect(await live.caseActionsOf(chosen, 'telegram_dispatch_approved')).toHaveLength(2);
      stand.clock.advance(1_000);
      await live.receive(chosen, 'STOP');
      await live.app.drain();
      expect((await live.chatFor(chosen))?.telegramReplyHold.contactOptedOut).toBe(true);
      await page.locator('#chat-header').getByText(/Ali is silent: the contact opted out/).waitFor();
      const blocked = page.waitForResponse(res => new URL(res.url()).pathname === '/v1/dispatches' && res.request().method() === 'POST');
      await dispatch.click();
      expect((await (await blocked).json()).data.results[0].telegram.reason).toBe('opted_out');
      await live.app.drain();
      expect(stand.sender.to(chosen)).toHaveLength(2);
      expect(await live.caseActionsOf(chosen, 'telegram_dispatch_approved')).toHaveLength(2);
      expect(stand.sender.to(unrelated)).toHaveLength(0);
    } finally { await live.stop(); }
  });

  it('lets a linked officer turn off saved all-DM replies while the worker is offline', async () => {
    const env = { ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST-ALL-DMS', TELEGRAM_APPROVED_CHAT_IDS: '6000000992' };
    let live = await TelegramHarness.start(env, standIns());
    try {
      expect((await live.call('POST', '/v1/telegram/dm-replies', { enabled: true })).data.enabled).toBe(true);
      await live.close();
      live = await TelegramHarness.start({ ...env, TELEGRAM_AI_REPLIES_ENABLED: 'false' }, standIns(), live.data);
      const { page } = await openDashboard(live.data.token, live.url);
      await openSettings(page);
      const toggle = page.getByRole('switch', { name: 'Auto-reply to every Telegram DM' });
      await page.getByText('Telegram replies are offline.', { exact: false }).waitFor();
      expect(await toggle.getAttribute('aria-checked')).toBe('true');
      await toggle.click();
      await toggle.waitFor({ state: 'hidden' });
      await page.getByRole('dialog', { name: 'Telegram settings' }).getByText('Automatic replies are off for the linked Telegram account.').waitFor();
      expect((await live.call('GET', '/v1/telegram/dm-replies')).data).toMatchObject({ available: false, enabled: false });
    } finally { await live.stop(); }
  });

  it('holds replies on the first shared bank transfer details and exposes values only in the source message', async () => {
    const contact = 6000000708;
    const stand = standIns();
    const live = await TelegramHarness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact) }, stand);
    try {
      const sentAt = stand.clock.now().getTime();
      await live.deliver(incoming(contact, 'Checking in.', sentAt));
      await live.dispatch(contact);
      const chat = (await live.chatFor(contact))!;
      const { page, problems } = await openDashboard(live.data.token, live.url);
      await openChat(page, chat.displayLabel);
      const fixtureNumber = '000000123456';
      await live.deliver(incoming(contact, 'Here are the photos: https://seller.example.test/photos', sentAt));
      await live.deliver(incoming(contact, `Pay by bank transfer to account number ${fixtureNumber}.`, sentAt));
      const header = page.locator('#chat-header');
      const item = inboxItem(page, 'Open chats', chat.displayLabel);
      await item.getByText('2 items for officer review', { exact: true }).waitFor();
      await header.getByText('Link warning', { exact: true }).waitFor();
      await header.getByText('Bank details are holding replies.', { exact: true }).waitFor();
      const bankRow = header.locator('li[data-reason="bank_details"]');
      const source = bankRow.getByRole('link', { name: 'Review shared bank transfer details' });
      await source.click();
      await page.locator('#timeline article[data-kind="message"].focused').filter({ hasText: fixtureNumber }).waitFor();
      await openEvidence(page);
      for (const secondary of [item, header, page.locator('#case-log')]) {
        expect(await secondary.innerText()).not.toContain(fixtureNumber);
      }
      await page.locator('#close-evidence').click();
      await bankRow.getByRole('button', { name: 'Mark reviewed' }).click();
      await source.waitFor({ state: 'hidden' });
      await header.getByText('Automated replies can continue.', { exact: true }).waitFor();
      expect((await live.chatFor(contact))!.telegramReplyHold).toMatchObject({ evidenceItems: [{ reason: 'link' }], officerReview: null });
      expect(stand.sender.sent).toHaveLength(0);
      expect(problems).toEqual([]);
    } finally {
      await live.stop();
    }
  });

  it('shows a conversation warning while Ali replies and clears it when acknowledged', async () => {
    const contact = 6000000890;
    const stand = standIns();
    const assess: NonNullable<ReplyGenerator['decide']> = async () =>
      ({ kind: 'review', status: 'HUMAN_INTERVENTION_REQUIRED', reasons: ['sensitive_request'] });
    Object.assign(stand.generator, { decide: assess, composePublicReply: async () => 'My name is Ali.' });
    const live = await TelegramHarness.start({
      ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true',
    }, stand);
    try {
      const text = 'What is your full name?';
      await live.receive(contact, text);
      await live.app.drain();
      const chat = (await live.chatFor(contact))!;
      const { page, problems } = await openDashboard(live.data.token, live.url);
      await page.locator('#inbox-filter-review').click();
      await page.locator('#inbox').getByText('Conversation warning', { exact: true }).waitFor();
      await openChat(page, chat.displayLabel);
      const header = page.locator('#chat-header');
      const summary = 'Ali flagged a request for sensitive information.';
      await header.getByText(summary, { exact: true }).waitFor();
      await header.getByText('Conversation warning', { exact: true }).waitFor();
      await header.getByText('Automated replies can continue.', { exact: true }).waitFor();
      expect(stand.sender.to(contact).map(item => item.reply.text)).toEqual(['My name is Ali.']);
      const source = header.getByRole('link', { name: 'View flagged message' });
      await source.click();
      const message = page.locator('#timeline article[data-kind="message"].focused').filter({ hasText: text });
      await message.getByText('Conversation warning', { exact: true }).waitFor();
      await header.getByRole('button', { name: 'Mark reviewed' }).click();
      await source.waitFor({ state: 'hidden' });
      await message.locator('.evidence-warning').waitFor({ state: 'hidden' });
      await openEvidence(page);
      await page.locator('#case-log').getByText('Conversation warning recorded', { exact: true }).waitFor();
      await page.locator('#case-log').getByText(summary, { exact: true }).waitFor();
      expect((await live.chatFor(contact))!.telegramReplyHold).toMatchObject({ officerReview: null, evidenceItems: [] });
      expect(problems).toEqual([]);
    } finally { await live.stop(); }
  });

  it('shows one link warning while Ali replies and keeps the same link cleared after review', async () => {
    const contact = 6000000896;
    const otherContact = 6000000895;
    const stand = standIns();
    const assessPayment: NonNullable<ReplyGenerator['decide']> = async (history, _signal, _correction, _turn, _memory, context) => ({
      kind: 'reply', text: history.some(turn => turn.from === 'owner') ? 'Can you tell me the size?' : 'Is it still available?',
      ...(context?.paymentLinks?.length ? { paymentLinkReview: { candidateId: 1, reason: 'unverified_payment_request' } } : {}),
    });
    Object.assign(stand.generator, { decide: assessPayment });
    const live = await TelegramHarness.start({
      ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: [contact, otherContact].join(','), TELEGRAM_AI_AUTO_START: 'true',
    }, stand);
    try {
      await live.receive(otherContact, 'Can you confirm the time?');
      const otherChat = (await live.chatFor(otherContact))!;
      const url = 'https://seller.example.test/item/fixture';
      await live.receive(contact, `Use this site first. ${url}`);
      await live.app.drain();
      const chat = (await live.chatFor(contact))!;
      const { page, problems } = await openDashboard(live.data.token, live.url);
      const inbox = page.locator('#inbox');
      const otherLink = inbox.getByRole('link', { name: otherChat.displayLabel, exact: true });
      await otherLink.waitFor();
      await page.locator('#inbox-filter-review').click();
      await otherLink.waitFor({ state: 'hidden' });
      await openChat(page, chat.displayLabel);
      const reviewRow = page.locator('#chat-header .review-item-warning');
      await reviewRow.getByText('Payment link warning', { exact: true }).waitFor();
      await page.locator('#chat-header').getByText('Automated replies can continue.', { exact: true }).waitFor();
      expect(stand.sender.to(contact)).toHaveLength(1);
      const source = reviewRow.getByRole('link', { name: 'View payment link source' });
      expect(await source.getAttribute('href')).toMatch(/^#\/chats\/.*\/messages\/.*\/events\//u);
      await source.click();
      const message = page.locator('#timeline article.focused').filter({ hasText: url });
      await message.locator('.evidence-warning').waitFor();
      await reviewRow.getByRole('button', { name: 'Mark reviewed' }).click();
      await reviewRow.waitFor({ state: 'hidden' });
      await page.locator('#timeline .evidence-warning').waitFor({ state: 'hidden' });
      await inbox.getByRole('link', { name: chat.displayLabel, exact: true }).waitFor({ state: 'hidden' });
      await live.receive(contact, `Here is that link again. ${url}`);
      await live.app.drain();
      expect(stand.sender.to(contact)).toHaveLength(2);
      expect((await live.chatFor(contact))!.telegramReplyHold).toMatchObject({ officerReview: null, evidenceItems: [] });
      await page.reload();
      await page.locator('#chat-header').getByText('Ali is handling replies', { exact: true }).waitFor();
      expect(await reviewRow.count()).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await live.stop();
    }
  });

  it('keeps both chats idle when their contacts have supplied the same number', async () => {
    const contacts = [6000000946, 6000000947];
    const number = '+44 7700 900146';
    const stand = standIns();
    const live = await TelegramHarness.start({
      ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: contacts.join(','), TELEGRAM_AI_AUTO_START: 'false',
    }, stand);
    try {
      for (const contact of contacts) {
        const update = incoming(contact, '', stand.clock.now().getTime());
        const message = update.business_message as Record<string, unknown>;
        delete message.text;
        message.contact = { phone_number: number, user_id: contact, first_name: 'Test' };
        await live.deliver(update);
      }
      const { page } = await openDashboard(live.data.token, live.url);
      await page.locator('#open-phone-dispatch').click();
      const dialog = page.locator('#phone-dispatch-dialog');
      await dialog.getByLabel('Phone number').fill(number);
      const response = page.waitForResponse(res => new URL(res.url()).pathname === '/v1/dispatches/by-phone');
      await dialog.getByRole('button', { name: 'Dispatch', exact: true }).click();
      expect((await (await response).json()).data).toEqual({ outcome: 'ambiguous' });
      await dialog.getByRole('status').filter({ hasText: /more than one|multiple|several/i }).waitFor();
      expect(await dialog.getByRole('link', { name: 'Open conversation' }).isVisible()).toBe(false);
      expect(await dialog.getByRole('button', { name: 'Draft first message' }).isVisible()).toBe(false);
      for (const contact of contacts) {
        expect(await live.caseActionsOf(contact, 'dispatch_started')).toHaveLength(0);
      }
      expect(stand.sender.sent).toHaveLength(0);
    } finally { await live.stop(); }
  });

  it('dispatches only the open case and preserves the officer’s batch selection', async () => {
    const label = 'Open Case Dispatch Contact';
    const otherLabel = 'Other Selected Dispatch Contact';
    const activeChat = await seedChat(h.accounts.intake, label, 'When is collection?');
    await seedChat(h.accounts.intake, otherLabel, 'Is the shop open?');
    const { page } = await openDashboard(h.tokens.officerA);
    const otherCheckbox = page.getByRole('checkbox', { name: `Select ${otherLabel}`, exact: true });
    await otherCheckbox.check();
    await openChat(page, label);
    await page.locator('#open-chat-dispatch').click();
    const context = 'Check the stated collection time if it comes up.';
    await page.locator('#chat-dispatch-context').fill(context);
    const dispatch = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/v1/dispatches');
    await page.locator('#confirm-chat-dispatch').click();
    expect((await dispatch).postDataJSON()).toEqual({ chatIds: [activeChat.chatId], officerContext: context });
    await inboxItem(page, 'Open chats', label).waitFor();
    expect(await otherCheckbox.isChecked()).toBe(true);
    expect(await inboxItem(page, 'New inbound', otherLabel).isVisible()).toBe(true);
  });

  it('dispatches a briefing only for its selected chat and opens an editable local draft for a new contact', async () => {
    const first = await seedChat(h.accounts.intake, 'Briefing Contact', 'Checking in.');
    await seedChat(h.accounts.intake, 'Other Briefing Contact', 'Checking in.');
    const { page, problems } = await openDashboard(h.tokens.officerA);
    const actions: { route: string; body: unknown }[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') actions.push({ route: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    const firstCheckbox = page.getByRole('checkbox', { name: 'Select Briefing Contact', exact: true });
    const otherCheckbox = page.getByRole('checkbox', { name: 'Select Other Briefing Contact', exact: true });
    const briefing = page.getByText('Dispatch briefing', { exact: true });
    const note = page.getByLabel('What should Ali keep in mind?', { exact: true });
    await firstCheckbox.check();
    await briefing.click();
    await note.fill('Unconfirmed earlier context for this chat.');
    await otherCheckbox.check();
    await briefing.waitFor({ state: 'hidden' });
    await otherCheckbox.uncheck();
    await briefing.click();
    expect(await note.inputValue()).toBe('');
    await note.fill('Earlier report mentioned an upfront fee.');
    await button(page, 'Dispatch').click();
    await inboxItem(page, 'Open chats', 'Briefing Contact').waitFor();
    expect(actions).toEqual([{ route: '/v1/dispatches', body: {
      chatIds: [first.chatId], officerContext: 'Earlier report mentioned an upfront fee.',
      participantPermissionRecorded: true, replyAgain: true,
    } }]);

    await button(page, 'Draft first message').click();
    const dialog = page.getByRole('dialog', { name: 'Draft a first message' });
    await dialog.getByLabel('Officer briefing').fill('The offer mentioned hiring.');
    await dialog.getByLabel('Language').selectOption('arabic');
    await dialog.getByRole('button', { name: 'Generate draft' }).click();
    const draft = dialog.getByLabel('Opening message draft');
    await draft.waitFor();
    expect(await draft.inputValue()).toContain('شو طبيعة الشغل');
    await draft.fill('هلا، ممكن توضح طبيعة الشغل؟');
    expect(await draft.inputValue()).toBe('هلا، ممكن توضح طبيعة الشغل؟');
    expect(await dialog.getByRole('button', { name: 'Copy draft' }).isVisible()).toBe(true);
    expect(actions[1]).toEqual({ route: '/v1/investigation-opener',
      body: { officerContext: 'The offer mentioned hiring.', language: 'arabic' } });
    await dialog.getByRole('button', { name: 'Close' }).click();
    expect(actions).toHaveLength(2);
    expect(problems).toEqual([]);
  });

  it('shows the reason for silence next to its source message and preserves older skips', async () => {
    const label = 'Test Contact Silence';
    const model = await seedChat(h.accounts.officer, label, 'Is there anything else?');
    const guarded = await ingestMessage(h.accounts.officer, model.externalChatId, label, 2, 'Are you a bot?');
    const legacy = await ingestMessage(h.accounts.officer, model.externalChatId, label, 3, 'An older message.');
    const db = openDatabase(path.join(h.dataDir, DATABASE_FILE));
    try {
      db.transaction(tx => {
        const { workspace_id: workspaceId } = tx.get<{ workspace_id: string }>('SELECT workspace_id FROM chats WHERE id=?', [model.chatId])!;
        const base = { workspaceId, chatId: model.chatId, type: 'ai_reply_skipped' as const, actorId: null };
        recordCaseAction(tx, { ...base, messageId: model.messageId, detail: { source: 'model', reason: 'already_answered' } });
        recordCaseAction(tx, { ...base, messageId: guarded.messageId, detail: { source: 'reply_guard', reason: 'repeated_identity_question' } });
        recordCaseAction(tx, { ...base, messageId: legacy.messageId });
      });
    } finally { db.close(); }
    const { page, problems } = await openDashboard(h.tokens.officerA);
    await openChat(page, label);
    await openEvidence(page);
    const skipped = page.locator('#case-log li[data-action-type="ai_reply_skipped"]');
    const modelEntry = skipped.filter({ hasText: 'The model considered the question already answered.' });
    await skipped.getByText('Mirsad suppressed a repeat answer to the same question about Ali’s identity.', { exact: true }).waitFor();
    await skipped.getByText('No reason was recorded.', { exact: true }).waitFor();
    await modelEntry.getByRole('link', { name: 'Go to the message' }).click();
    await page.locator('#timeline article.focused').filter({ hasText: 'Is there anything else?' }).waitFor();
    const modelBubble = page.locator(`#message-${model.messageId}`);
    const guardBubble = page.locator(`#message-${guarded.messageId}`);
    const legacyBubble = page.locator(`#message-${legacy.messageId}`);
    await modelBubble.getByText('The model considered the question already answered.', { exact: true }).waitFor();
    await guardBubble.getByText('Mirsad suppressed a repeat answer to the same question about Ali’s identity.', { exact: true }).waitFor();
    await legacyBubble.getByText('No reason was recorded.', { exact: true }).waitFor();
    expect(await modelBubble.getByText('No reason was recorded.', { exact: true }).count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it('adds the skip reason to an already open conversation as the model decision arrives', async () => {
    const contact = 6000000891;
    const stand = standIns();
    let finishDecision!: () => void;
    const decisionReady = new Promise<void>(resolve => { finishDecision = resolve; });
    Object.assign(stand.generator, { decide: async () => {
      await decisionReady;
      return { kind: 'silence', reason: 'ordinary_terms_clear' };
    } });
    const live = await TelegramHarness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact) }, stand);
    try {
      const latest = await live.receive(contact, 'Those are all the terms.');
      const chat = (await live.chatFor(contact))!;
      const { page, problems } = await openDashboard(live.data.token, live.url);
      await openChat(page, chat.displayLabel);
      const bubble = page.locator(`#message-${latest.id}`);
      const reason = 'The model considered the terms of the offer clear.';
      await bubble.getByText('Those are all the terms.', { exact: true }).waitFor();
      expect(await bubble.getByText(reason, { exact: true }).count()).toBe(0);
      await live.dispatch(contact);
      finishDecision();
      await bubble.getByText(reason, { exact: true }).waitFor();
      await openEvidence(page);
      await page.locator('#case-log').getByText(reason, { exact: true }).waitFor();
      expect(stand.sender.to(contact)).toHaveLength(0);
      expect(problems).toEqual([]);
    } finally {
      finishDecision();
      await live.stop();
    }
  });

  it('keeps replies enabled for links and documents and lets the officer acknowledge each source', async () => {
    const contact = 6000000707;
    const stand = standIns();
    const live = await TelegramHarness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact) }, stand);
    try {
      const sentAt = stand.clock.now().getTime();
      const original = incoming(contact, 'I can share the checkout details.', sentAt);
      await live.deliver(original);
      await live.dispatch(contact);
      const chat = (await live.chatFor(contact))!;
      const { page, problems } = await openDashboard(live.data.token, live.url);
      await openChat(page, chat.displayLabel);
      const header = page.locator('#chat-header');
      const item = inboxItem(page, 'Open chats', chat.displayLabel);
      const edit = incoming(contact, 'Here is the payment link: https://pay.example.test/checkout/fixture.', sentAt);
      await live.deliver({ update_id: edit.update_id, edited_business_message: {
        ...(edit.business_message as object), message_id: (original.business_message as { message_id: number }).message_id,
      } });
      await item.getByText('Payment link warning', { exact: true }).waitFor();
      await header.getByText('Automated replies can continue.', { exact: true }).waitFor();
      expect(await header.getByRole('button', { name: 'Mark reviewed' }).count()).toBe(1);
      const payment = header.getByRole('link', { name: 'View payment link source' });
      await payment.click();
      await page.locator('#timeline article[data-event-type="edited"].focused').filter({ hasText: '/checkout/fixture' }).waitFor();
      await header.getByRole('button', { name: 'Pause AI' }).click();
      await header.getByText('AI paused', { exact: true }).waitFor();
      expect(await header.getByText('Automated replies can continue.').count()).toBe(0);
      await header.getByRole('button', { name: 'Resume AI' }).click();
      await header.getByText('Automated replies can continue.', { exact: true }).waitFor();

      const shared = incoming(contact, 'Invoice attached.', sentAt);
      Object.assign(shared.business_message as object, { document: { file_id: 'fixture-only-file', file_unique_id: 'fixture-only-invoice' } });
      await live.deliver(shared);
      await item.getByText('2 items for officer review', { exact: true }).waitFor();
      await header.getByText('Automated replies can continue.', { exact: true }).waitFor();
      const documentRow = header.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Review shared document' }) });
      await documentRow.getByRole('link').click();
      await page.locator('#timeline article[data-kind="message"].focused').filter({ hasText: 'Invoice attached.' }).waitFor();
      await header.getByRole('button', { name: 'Take over' }).click();
      await header.getByText('Officer control', { exact: true }).waitFor();
      await live.deliver(incoming(contact, 'Please stop messaging me.', sentAt));
      await item.getByText('Contact opted out', { exact: true }).waitFor();

      const reviewId = (await live.chatFor(contact))!.telegramReplyHold.evidenceItems.find((e: { reason: string }) => e.reason === 'document').actionId;
      const resolve = async (id: string) => live.call('POST', `/v1/chats/${chat.id}/officer-decisions`, {
        decision: 'mark_reviewed', reviewActionId: id, expectedRevision: (await live.chatFor(contact))!.revision,
      });
      expect((await resolve('not-a-review-in-this-chat')).success).toBe(false);
      await documentRow.getByRole('button', { name: 'Mark reviewed' }).click();
      await documentRow.waitFor({ state: 'hidden' });
      await item.getByText('Payment link warning', { exact: true }).waitFor();
      expect(await header.getByText('Bank details are holding replies.').count()).toBe(0);
      expect((await resolve(reviewId)).data.created).toBe(false);
      await header.getByRole('button', { name: 'Mark reviewed' }).click();
      await payment.waitFor({ state: 'hidden' });
      await item.getByText('Contact opted out', { exact: true }).waitFor();
      await header.getByText('Officer control', { exact: true }).waitFor();
      const result = await live.timelineOf(contact);
      expect(result.chat.telegramReplyHold).toMatchObject({ contactOptedOut: true, officerReview: null, evidenceItems: [] });
      expect(result.caseActions.filter((a: { type: string }) => a.type === 'telegram_officer_review_resolved')).toHaveLength(2);
      expect(result.findings).toHaveLength(0);
      await live.deliver(incoming(contact, 'The pickup address is 18 Sample Street.', sentAt));
      await item.getByText('1 item for officer review', { exact: true }).waitFor();
      const location = header.getByRole('link', { name: 'Review shared location' });
      await location.click();
      await page.locator('#timeline article[data-kind="message"].focused').filter({ hasText: '18 Sample Street' }).waitFor();
      expect(await header.getByRole('button', { name: 'Mark reviewed' }).count()).toBe(1);
      expect(await header.getByText('Automated replies can continue.').count()).toBe(0);
      expect(stand.sender.sent).toHaveLength(0);
      expect(problems).toEqual([]);
    } finally {
      await live.stop();
    }
  });

  it('an officer signs in, sees the New inbound chat, dispatches two chats, takes one over, finds the composer blank, inserts the acknowledgement, sends, and sees one Simulated send message', async () => {
    const inbound = await seedChat(h.accounts.intake, 'Test Contact 1', 'Hello, is anyone there?');
    await seedChat(h.accounts.officer, 'Test Contact 2', 'Good morning, this is the order desk.', 'outgoing');
    await h.drain();

    const { page, problems } = await openDashboard(h.tokens.officerA);
    expect(page.url()).toBe(`${h.baseUrl}/`);

    const queued = inboxItem(page, 'New inbound', 'Test Contact 1');
    await queued.waitFor();
    expect(await queued.textContent()).toContain('Telegram');

    // The checkbox carries its own name, so tools that do not read the wrapping label do not announce it as "on".
    const selectFirst = page.getByRole('checkbox', { name: 'Select Test Contact 1', exact: true });
    expect(await selectFirst.getAttribute('aria-label')).toBe('Select Test Contact 1');
    await selectFirst.check();
    await page.getByRole('checkbox', { name: 'Select Test Contact 2', exact: true }).check();
    await button(page, 'Dispatch').click();
    await inboxItem(page, 'Open chats', 'Test Contact 1').filter({ hasText: 'AI active' }).waitFor();
    await inboxItem(page, 'Open chats', 'Test Contact 2').filter({ hasText: 'AI active' }).waitFor();
    expect(await inboxItem(page, 'New inbound', 'Test Contact 1').count()).toBe(0);

    await openChat(page, 'Test Contact 1');
    expect(await page.locator('#chat-header').textContent()).toContain('First observed: incoming');
    // The capture is fetched with the token and shown from a blob: URL under the dashboard CSP.
    await openMessageDetails(page.locator(`#message-${inbound.messageId}`));
    const capture = page.locator('#timeline article[data-kind="message"] figure.capture[data-state="loaded"]');
    await capture.waitFor();
    expect(await capture.textContent()).toContain('Mirsad-rendered capture');
    expect(await page.locator('#workspace').innerText()).not.toMatch(/\b(null|undefined)\b/);

    await button(page, 'Take over').click();
    await replyBox(page).waitFor();
    expect(await replyBox(page).inputValue()).toBe('');

    const composerPosts: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/officer-messages')) composerPosts.push(request.method());
    });
    await button(page, 'Insert acknowledgement').click();
    expect(await replyBox(page).inputValue()).toBe('Message received.');
    expect(composerPosts).toEqual([]);
    expect(await outgoingEntries(page).count()).toBe(0);

    await button(page, 'Send').click();
    const sent = page.locator('#timeline article[data-origin="officer_composer"]');
    await sent.first().waitFor();
    await expect.poll(() => replyBox(page).inputValue(), { timeout: UI_TIMEOUT_MS }).toBe('');
    expect(await sent.count()).toBe(1);
    const shown = (await sent.first().textContent()) ?? '';
    expect(shown).toContain('Message received.');
    expect(shown).toContain('Simulated send');
    expect(shown).toContain('Officer A');
    expect(shown).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    expect(composerPosts).toEqual(['POST']);

    const stored = await timelineOf(inbound.chatId);
    expect(stored.messages.filter((m) => m.origin === 'officer_composer').map((m) => m.text)).toEqual(['Message received.']);
    expect(problems).toEqual([]);
  });

  it('a new chat and a further message that arrive while the dashboard is open appear without any action by the officer', async () => {
    const label = 'Test Contact 10';
    const existing = await seedChat(h.accounts.intake, label, 'Hello, I am waiting for my parcel.');
    const { page, problems } = await openDashboard(h.tokens.officerA);
    await openChat(page, label);
    const messages = page.locator('#timeline article[data-kind="message"]');
    await messages.first().waitFor();
    await page.locator('#connection-status').filter({ hasText: 'Live updates on' }).waitFor();

    // Both arrive over HTTP through the fixture connector; nothing is clicked in the page from here on.
    await seedChat(h.accounts.intake, 'Test Contact 11', 'Good evening, is the shop open tomorrow?');
    await ingestMessage(h.accounts.intake, existing.externalChatId, label, 2, 'It was due yesterday.');

    await inboxItem(page, 'New inbound', 'Test Contact 11').waitFor();
    await page.locator('#timeline .message-text').filter({ hasText: 'It was due yesterday.' }).waitFor();
    expect(await messages.count()).toBe(2);
    expect(problems).toEqual([]);
  });

  it('Leave unanswered adds a case-log line and no outgoing message', async () => {
    const chat = await seedChat(h.accounts.officer, 'Test Contact 3', 'Can you call me back later today?');
    const { page, problems } = await openDashboard(h.tokens.officerA);
    await openChat(page, 'Test Contact 3');
    await button(page, 'Take over').click();
    await replyBox(page).waitFor();
    expect(await page.getByRole('radio', { name: 'Select this message', exact: true }).isChecked()).toBe(true);

    await button(page, 'Leave unanswered').click();
    await openEvidence(page);
    const logged = page.locator('#case-log li[data-action-type="leave_unanswered"]');
    await logged.waitFor();
    const line = (await logged.textContent()) ?? '';
    expect(line).toContain('Leave unanswered');
    expect(line).toContain('Officer A');
    expect(await outgoingEntries(page).count()).toBe(0);
    expect(await replyBox(page).isVisible()).toBe(true);

    const stored = await timelineOf(chat.chatId);
    expect(stored.messages.map((m) => m.direction)).toEqual(['incoming']);
    expect(stored.caseActions.filter((a) => a.type === 'leave_unanswered').map((a) => a.messageId)).toEqual([chat.messageId]);
    expect(problems).toEqual([]);
  });

  it('the Leave unanswered target follows each newer incoming message until the officer picks one', async () => {
    const label = 'Test Contact 7';
    const first = await seedChat(h.accounts.officer, label, 'Is the blue lamp still available?');
    const { page, problems } = await openDashboard(h.tokens.officerA);
    await openChat(page, label);
    await button(page, 'Take over').click();
    await replyBox(page).waitFor();
    const target = (messageId: string): Locator => page.locator(`#message-${messageId}`).getByRole('radio', { name: 'Select this message', exact: true });
    const leaveLines = page.locator('#case-log li[data-action-type="leave_unanswered"]');
    const leftUnanswered = async () => (await timelineOf(first.chatId)).caseActions.filter((a) => a.type === 'leave_unanswered').map((a) => a.messageId);

    expect(await target(first.messageId).isChecked()).toBe(true);
    await button(page, 'Leave unanswered').click();
    await expect.poll(() => leaveLines.count(), { timeout: UI_TIMEOUT_MS }).toBe(1);

    // A newer message arrives while the chat is open: the default target moves to it.
    const second = await ingestMessage(h.accounts.officer, first.externalChatId, label, 2, 'Hello? Please answer when you can.');
    await target(second.messageId).waitFor();
    await expect.poll(() => target(second.messageId).isChecked(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await button(page, 'Leave unanswered').click();
    await expect.poll(() => leaveLines.count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    expect(await leftUnanswered()).toEqual([first.messageId, second.messageId]);

    // Once the officer picks a message, it stays the target when another one arrives.
    await target(first.messageId).check();
    const third = await ingestMessage(h.accounts.officer, first.externalChatId, label, 3, 'I will try again tomorrow.');
    await target(third.messageId).waitFor();
    expect(await target(first.messageId).isChecked()).toBe(true);
    expect(await target(third.messageId).isChecked()).toBe(false);
    expect(problems).toEqual([]);
  });

  it('an incoming message that carries the sender phone shows it as Sender phone, isolated for bidirectional text', async () => {
    const label = 'Test Contact 8';
    const phone = '+44 7700 900123';
    // The contact's own Telegram contact card: no text, and the number arrives as sender metadata.
    const sender = { externalId: 'tg-user-own-card', displayName: label, phone: { raw: phone, internationalFormat: true } };
    const event = recorded({ messageId: 1, text: '', unsupportedContent: ['contact'], sender });
    const res = await h.http(h.tokens.connector).post('/v1/ingest', envelope(h.accounts.intake, uniqueId('chat-'), event, label));
    expect(res.status, res.text).toBe(CREATED);
    expect((await timelineOf(res.body.data.chatId)).messages[0]?.sender?.phone).toBe(phone);

    const { page, problems } = await openDashboard(h.tokens.officerA);
    await openChat(page, label);
    await openMessageDetails(page.locator(`#message-${res.body.data.messageId}`));
    const facts = page.locator(`#message-${res.body.data.messageId} dl.facts`);
    await facts.waitFor();
    expect(await facts.locator('dt:text-is("Sender phone") + dd bdi').textContent()).toBe(phone);
    expect(problems).toEqual([]);
  });

  it('an officer records a merchant confirmation in the case panel, sees it listed, and the conflicting link becomes Suspected fraud', async () => {
    const label = 'Test Contact 9';
    const chat = await seedChat(h.accounts.intake, label, 'Please settle the invoice here: https://pay.other-host.test/invoice/9');
    const dispatched = await h.http(h.tokens.officerA).post('/v1/dispatches', { chatIds: [chat.chatId] }, { 'Idempotency-Key': uniqueId('dispatch-') });
    expect(dispatched.status, dispatched.text).toBe(OK);
    await h.drain();
    expect((await timelineOf(chat.chatId)).findings.map((f) => f.kind)).toEqual(['payment_link']);

    const { page, problems } = await openDashboard(h.tokens.officerA);
    await openChat(page, label);
    await page.locator('#timeline aside.finding-payment_link').waitFor();
    const posted: unknown[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/case-references')) posted.push(request.postDataJSON());
    });
    await openEvidence(page);
    await page.getByText('Add merchant confirmation', { exact: true }).click();
    const hosts = page.getByRole('textbox', { name: 'Payment hosts (comma or newline separated)', exact: true });
    const note = page.getByRole('textbox', { name: 'Source note', exact: true });
    const record = button(page, 'Record merchant confirmation');
    expect(await record.isDisabled()).toBe(true);

    await hosts.fill('pay.merchant.test,\nshop.merchant.test');
    await note.fill(CONFIRMATION_NOTE);
    await record.click();

    const listed = page.locator('#case-references li[data-case-reference-id]');
    await listed.waitFor();
    const shown = (await listed.textContent()) ?? '';
    expect(shown).toContain('pay.merchant.test, shop.merchant.test');
    expect(shown).toContain(CONFIRMATION_NOTE);
    expect(shown).toContain('Officer A');
    expect(shown).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    await page.locator('#notice').filter({ hasText: 'Merchant confirmation recorded. 1 payment link marked Suspected fraud.' }).waitFor();
    await page.locator('#timeline aside.finding-suspected_fraud').waitFor();
    await page.locator('#case-log li[data-action-type="case_reference_recorded"]').waitFor();
    await expect.poll(() => hosts.inputValue(), { timeout: UI_TIMEOUT_MS }).toBe('');
    expect(await note.inputValue()).toBe('');

    expect(posted).toEqual([{ kind: 'merchant_payment_confirmation', paymentHosts: ['pay.merchant.test', 'shop.merchant.test'], sourceNote: CONFIRMATION_NOTE }]);
    const stored = await timelineOf(chat.chatId);
    expect(stored.caseReferences.map((reference) => reference.paymentHosts)).toEqual([['pay.merchant.test', 'shop.merchant.test']]);
    expect(stored.findings.map((f) => f.kind).sort()).toEqual(['payment_link', 'suspected_fraud']);
    expect(problems).toEqual([]);
  });

  it('message text containing markup is shown literally', async () => {
    const label = '<b>Test Contact 4</b>';
    const text = 'Hi <img src=x onerror="globalThis.__mirsadInjected = 1"> <script>globalThis.__mirsadInjected = 2</script> <b>plain</b> & more';
    await seedChat(h.accounts.intake, label, text);
    const { page, problems } = await openDashboard(h.tokens.officerA);
    await openChat(page, label);

    const shown = page.locator('#timeline .message-text').first();
    await shown.waitFor();
    expect(await shown.textContent()).toBe(text);
    expect(await shown.innerHTML()).toContain('&lt;img');
    expect(await page.locator('#inbox b, #chat-header b, #timeline b, #timeline img:not(.capture-image), script:not([src])').count()).toBe(0);
    expect(await page.evaluate('globalThis.__mirsadInjected')).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it('a second officer does not get the composer', async () => {
    const chat = await seedChat(h.accounts.intake, 'Test Contact 5', 'Is this the right number for the order desk?');
    const takeOver = await h.http(h.tokens.officerA).post(`/v1/chats/${chat.chatId}/control`, { action: 'take_over', expectedRevision: 1 });
    expect(takeOver.status, takeOver.text).toBe(OK);

    const second = await openDashboard(h.tokens.officerB);
    await openChat(second.page, 'Test Contact 5');
    const header = second.page.locator('#chat-header');
    await header.getByText('Officer control', { exact: false }).waitFor();
    expect(await header.textContent()).toContain('Officer A');
    expect(await replyBox(second.page).count()).toBe(0);
    expect(await button(second.page, 'Send').count()).toBe(0);
    expect(await button(second.page, 'Leave unanswered').count()).toBe(0);
    expect(await button(second.page, 'Insert acknowledgement').count()).toBe(0);
    expect(await button(second.page, 'Resume AI').isDisabled()).toBe(true);

    // The controlling officer, on the same chat, does get it.
    const controller = await openDashboard(h.tokens.officerA);
    await openChat(controller.page, 'Test Contact 5');
    await replyBox(controller.page).waitFor();
    expect(await replyBox(controller.page).inputValue()).toBe('');
    expect(second.problems).toEqual([]);
    expect(controller.problems).toEqual([]);
  });

  it('Retry capture still works after a retry request that the service refused', async () => {
    await h.drain();
    h.renderer.failNext(1);
    const chat = await seedChat(h.accounts.intake, 'Test Contact 6', 'Hello, I sent the photo of the receipt earlier.');
    await h.drain();
    expect((await timelineOf(chat.chatId)).messages[0]?.capture?.status).toBe('failed');

    const { page, problems } = await openDashboard(h.tokens.officerA);
    await openChat(page, 'Test Contact 6');
    const message = page.locator(`#message-${chat.messageId}`);
    expect(await message.locator('.facts').isVisible()).toBe(false);
    const retry = button(page, 'Retry capture');
    await retry.waitFor();
    // The first request is answered 429, as a busy service would; it never reaches the service.
    await page.route('**/v1/captures/*/retry', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(RATE_LIMITED) }), { times: 1 });
    await retry.click();
    await page.locator('#notice').filter({ hasText: 'Too many requests' }).waitFor();

    await retry.click();
    await openMessageDetails(message);
    await page.locator('#timeline article[data-kind="message"] figure.capture[data-state="loaded"]').waitFor();
    const stored = await timelineOf(chat.chatId);
    expect(stored.messages[0]?.capture?.status).toBe('ready');
    expect(stored.caseActions.filter((a) => a.type === 'capture_retry_requested')).toHaveLength(1);
    // The browser reports the refused request itself as a failed resource load; nothing else may appear.
    expect(problems.filter((text) => !text.includes('status of 429'))).toEqual([]);
  });

  it('a #token= link pasted into an open tab signs in with that token and leaves the address bar, signed in or not', async () => {
    const { page, problems } = await openDashboard(h.tokens.officerA);
    const officerName = page.locator('#officer-name');
    await expect.poll(() => officerName.textContent(), { timeout: UI_TIMEOUT_MS }).toBe('Officer A');

    await pasteTokenLink(page, h.tokens.officerB);
    await expect.poll(() => officerName.textContent(), { timeout: UI_TIMEOUT_MS }).toBe('Officer B');
    expect(page.url()).toBe(`${h.baseUrl}/`);
    await page.getByRole('heading', { name: 'New inbound', exact: true }).waitFor();

    await button(page, 'Sign out').click();
    await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
    await pasteTokenLink(page, h.tokens.officerA);
    await expect.poll(() => officerName.textContent(), { timeout: UI_TIMEOUT_MS }).toBe('Officer A');
    await page.getByRole('heading', { name: 'New inbound', exact: true }).waitFor();
    expect(page.url()).toBe(`${h.baseUrl}/`);
    expect(problems).toEqual([]);
  });
});
