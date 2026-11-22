/**
 * The reference dashboard end to end (brief build step 3; design sections 6 and 12). A real Mirsad instance from the
 * test harness, chats seeded over HTTP by the fixture connector, and the installed Microsoft Edge or Google Chrome driven
 * headless through playwright-core, with the officer token passed in the URL fragment. When neither browser can be
 * launched, every test is skipped with the reason.
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Timeline } from '../../src/contract/schemas.ts';
import { envelope, recorded, uniqueId } from '../helpers/events.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const BROWSER_CHANNELS = ['msedge', 'chrome'] as const;
const UI_TIMEOUT_MS = 15_000;
const OK = 200;
const CREATED = 201;
const RATE_LIMITED = { success: false, data: null, error: { code: 'rate_limited', message: 'Too many requests.' } };

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
  if (!browser) context.skip(skipReason);
});

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

/** A chat created by its first message through the fixture connector; an incoming first message enters New inbound. */
async function seedChat(account: Account, label: string, text: string, direction: 'incoming' | 'outgoing' = 'incoming') {
  const sender = direction === 'incoming' ? { externalId: uniqueId('tg-user-'), displayName: label } : undefined;
  const event = recorded({ messageId: 1, direction, text, sender });
  const res = await h.http(h.tokens.connector).post('/v1/ingest', envelope(account, uniqueId('chat-'), event, label));
  expect(res.status, res.text).toBe(CREATED);
  return { chatId: res.body.data.chatId as string, messageId: res.body.data.messageId as string };
}

async function timelineOf(chatId: string): Promise<Timeline> {
  const res = await h.http(h.tokens.officerA).get(`/v1/chats/${chatId}/timeline`);
  expect(res.status, res.text).toBe(OK);
  return res.body.data as Timeline;
}

/** Opens the dashboard in a fresh browser context, signed in through the #token= fragment. */
async function openDashboard(token: string): Promise<Dashboard> {
  const context = await browser!.newContext();
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(UI_TIMEOUT_MS);
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  const response = await page.goto(`${h.baseUrl}/#token=${encodeURIComponent(token)}`);
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

/** What pasting a sign-in link into the address bar of an open tab does: only the fragment changes. */
async function pasteTokenLink(page: Page, token: string): Promise<void> {
  await page.evaluate((fragment) => {
    window.location.hash = fragment;
  }, `#token=${encodeURIComponent(token)}`);
}

const replyBox = (page: Page): Locator => page.getByRole('textbox', { name: 'Reply', exact: true });
const button = (page: Page, name: string): Locator => page.getByRole('button', { name, exact: true });
const outgoingEntries = (page: Page): Locator => page.locator('#timeline article[data-direction="outgoing"]');

describe('reference dashboard', () => {
  it('an officer signs in, sees the New inbound chat, dispatches two chats, takes one over, finds the composer blank, inserts the acknowledgement, sends, and sees one Simulated send message', async () => {
    const inbound = await seedChat(h.accounts.intake, 'Test Contact 1', 'Hello, is anyone there?');
    await seedChat(h.accounts.officer, 'Test Contact 2', 'Good morning, this is the order desk.', 'outgoing');
    await h.drain();

    const { page, problems } = await openDashboard(h.tokens.officerA);
    expect(page.url()).toBe(`${h.baseUrl}/`);

    const queued = inboxItem(page, 'New inbound', 'Test Contact 1');
    await queued.waitFor();
    expect(await queued.textContent()).toContain('Telegram');
    expect(await queued.textContent()).toContain('First observed: incoming');

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
    // The capture is fetched with the token and shown from a blob: URL under the dashboard CSP.
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

  it('Leave unanswered adds a case-log line and no outgoing message', async () => {
    const chat = await seedChat(h.accounts.officer, 'Test Contact 3', 'Can you call me back later today?');
    const { page, problems } = await openDashboard(h.tokens.officerA);
    await openChat(page, 'Test Contact 3');
    await button(page, 'Take over').click();
    await replyBox(page).waitFor();
    expect(await page.getByRole('radio', { name: 'Select this message', exact: true }).isChecked()).toBe(true);

    await button(page, 'Leave unanswered').click();
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
    const retry = button(page, 'Retry capture');
    await retry.waitFor();
    // The first request is answered 429, as a busy service would; it never reaches the service.
    await page.route('**/v1/captures/*/retry', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(RATE_LIMITED) }), { times: 1 });
    await retry.click();
    await page.locator('#notice').filter({ hasText: 'Too many requests' }).waitFor();

    await retry.click();
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
