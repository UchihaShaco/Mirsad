import fs from 'node:fs';
/**
 * Places map end to end: the officer opens the Places map from the nav, sees
 * the directory on a panned map, clicks a dot for its phones and links, and
 * filters with search. A real Mirsad instance serves the fixture directory with tiles from a local
 * stub upstream (no live internet); the installed Microsoft Edge or Google Chrome is driven headless through
 * playwright-core. Console errors and page errors (including any
 * Content-Security-Policy violation) fail the run.
 */
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadPlaces } from '../../src/places/store.ts';
import { importWebsiteChecks } from '../../src/places/website-checks.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { readWebsiteChecks } from '../../scripts/import-website-checks.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const TINY_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const BROWSER_CHANNELS = ['msedge', 'chrome'] as const;
const UI_TIMEOUT_MS = 15_000;

let h: TestHarness;
let browser: Browser | null = null;
let skipReason = '';
let upstream: http.Server;
let upstreamPort = 0;
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
  // Last, a Chromium that Playwright installed under ~/.cache/ms-playwright (for example for Python) at the revision
  // this playwright-core expects: a Linux machine often has that and neither Edge nor Chrome.
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    failures.push(`playwright chromium: ${firstLine(error)}`);
  }
  skipReason = `Skipped: neither Microsoft Edge, Google Chrome nor Playwright's Chromium could be launched by playwright-core (${failures.join('; ')}).`;
  return null;
}

beforeAll(async () => {
  const sample = fileURLToPath(new URL('../../fixtures/places/abu-dhabi-sample.json', import.meta.url));
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(TINY_PNG);
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  upstreamPort = (upstream.address() as AddressInfo).port;
  const places = loadPlaces(sample);
  h = await startHarness({ places, mapTileUpstream: `http://127.0.0.1:${upstreamPort}` });
  // The synthetic website checks report, imported the way the operator command does it.
  const db = openDatabase(path.join(h.dataDir, DATABASE_FILE));
  try {
    const { report, sha256 } = readWebsiteChecks(fileURLToPath(new URL('../../fixtures/places/website-checks-sample.json', import.meta.url)));
    importWebsiteChecks(db, report, new Set(places.map((place) => place.id)), { reportSha256: sha256 });
  } finally {
    db.close();
  }
  browser = await launchInstalledBrowser();
});

afterAll(async () => {
  await browser?.close();
  await h.close();
  await new Promise<void>((done) => upstream.close(() => done()));
});

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

interface Dashboard {
  page: Page;
  problems: string[];
}

async function openDashboard(): Promise<Dashboard> {
  const context = await browser!.newContext();
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(UI_TIMEOUT_MS);
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  const response = await page.goto(`${h.baseUrl}/#token=${encodeURIComponent(h.tokens.officerA)}`, {
    // The live event stream and tile images keep the load event back; the dashboard renders from DOMContentLoaded.
    waitUntil: 'domcontentloaded',
  });
  expect(response?.status()).toBe(200);
  await page.getByRole('heading', { name: 'New messages', exact: true }).waitFor();
  return { page, problems };
}

async function openPlaces(page: Page): Promise<void> {
  await page.locator('#view-nav').waitFor();
  await page.getByRole('link', { name: 'Places map', exact: true }).click();
  await page.getByRole('heading', { name: 'Places map', exact: true }).waitFor();
  await page.locator('.places-marker').first().waitFor();
  await expect.poll(() => page.locator('#places-status').textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/in view|match|empty|unavailable/);
}

describe('places map', () => {
  it('shows the directory on the map with tiles from our own origin', async (test) => {
    if (!browser) test.skip(skipReason);
    const { page, problems } = await openDashboard();
    await openPlaces(page);
    const markers = await page.locator('.places-marker').count();
    expect(markers).toBeGreaterThan(0);
    expect(markers).toBeLessThanOrEqual(200);
    expect(await page.locator('#places-status').textContent()).toMatch(/in view/);
    const tiles = await page.locator('.places-tile').count();
    expect(tiles).toBeGreaterThan(0);
    await page.locator('.places-tile[src]').first().waitFor();
    expect(problems).toEqual([]);
  });

  it('opens the place details with phones and links on dot click', async (test) => {
    if (!browser) test.skip(skipReason);
    const { page, problems } = await openDashboard();
    await openPlaces(page);
    // Narrow to one dot, then use a real click: this is the exact user path the pointer-capture bug broke.
    const name = (await page.locator('.places-marker').first().getAttribute('aria-label')) ?? '';
    expect(name.length).toBeGreaterThan(0);
    await page.getByLabel('Search names').fill(name);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect.poll(() => page.locator('.places-marker').count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await page.locator('.places-marker').first().click();
    await page.getByRole('heading', { name: 'Place details' }).waitFor();
    expect(await page.locator('#places-details-body h3').textContent()).toBe(name);
    const panel = await page.locator('#places-details-body').innerText();
    expect(panel).toContain('PHONES');
    expect(panel).toContain('Open in map');
    await page.locator('#places-details-close').click();
    await page.locator('#places-details').waitFor({ state: 'hidden' });
    expect(problems).toEqual([]);
  });

  it('filters the dots with the search box', async (test) => {
    if (!browser) test.skip(skipReason);
    const { page, problems } = await openDashboard();
    await openPlaces(page);
    const name = (await page.locator('.places-marker').first().getAttribute('aria-label')) ?? '';
    expect(name.length).toBeGreaterThan(0);
    await page.getByLabel('Search names').fill(name);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect.poll(() => page.locator('.places-marker').count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    expect(problems).toEqual([]);
  });

  it('shows flagged websites with a legend and filter, and explains a flag in the details without a live link', async (test) => {
    if (!browser) test.skip(skipReason);
    const { page, problems } = await openDashboard();
    await openPlaces(page);
    await expect.poll(() => page.locator('.places-marker.flag-harmful').count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    expect(await page.locator('#places-legend').innerText()).toContain('Harmful website');
    const filter = page.getByLabel('Flagged websites');
    await expect.poll(() => filter.locator('option').allTextContents()).toContain('Flagged websites (3)');
    expect(await filter.locator('option').allTextContents()).toContain('Low-confidence warning (1)');
    await filter.selectOption('flagged');
    await expect.poll(() => page.locator('.places-marker').count(), { timeout: UI_TIMEOUT_MS }).toBe(3);
    expect(await page.locator('.places-marker[data-website-flag]').count()).toBe(3);

    await page.locator('.places-marker.flag-harmful').click();
    const body = page.locator('#places-details-body');
    await body.getByText('Website check', { exact: true }).waitFor();
    const panel = await body.innerText();
    expect(panel).toContain('Harmful website');
    expect(panel).toContain("This listing's website now leads to an online gambling site");
    expect(panel).toContain('94 of 100 (Blocked)');
    expect(panel).toContain('hxxps://win-big-casino[.]test/landing?ref=lapsed');
    expect(panel).toContain('Redirects to an online gambling site');
    expect(panel).toContain('يحوّل إلى موقع قمار على الإنترنت');
    expect(panel).toContain('2026-11-24 09:01:12 UTC');
    expect(panel).toContain('SS-0A1B2C3D');
    // Neither the harmful destination nor the listing's own (taken-over) website is a link.
    const hrefs = await body.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    expect(hrefs.filter((href) => !href.startsWith('https://www.google.com/maps') && !href.startsWith('tel:'))).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('checks a reported number and website in Places from a citizen report, and opens the match on the map', async (test) => {
    if (!browser) test.skip(skipReason);
    const report = JSON.parse(fs.readFileSync(new URL('../../contracts/fixtures/citizen-report.v1.json', import.meta.url), 'utf8'));
    report.reportId = 'mrs-0b1aced00001';
    report.artifacts.phones = ['+971 2 642 9176'];
    const imported = await h.http(h.tokens.officerA).post('/v1/citizen-reports', { report });
    expect(imported.status, imported.text).toBe(201);
    const { page, problems } = await openDashboard();
    await page.goto(`${h.baseUrl}/#/chats/${imported.body.data.chatId}`);
    const details = page.locator('#timeline .report-details');
    await details.waitFor();
    // The call-back number in the scam belongs to a real shop: the scammer borrowed it.
    await details.getByRole('button', { name: 'Check +971 2 642 9176 in Places' }).click();
    await details.getByText('Listed in Places:', { exact: false }).waitFor();
    expect(await details.locator('.places-listed').innerText()).toContain('Aesop (beauty supply store)');
    // The scam's own domain is no business in the directory.
    await details.getByRole('button', { name: 'Check adpolice-fines.example in Places' }).click();
    await details.getByText('Not listed for any business in Places.', { exact: true }).waitFor();
    await details.getByRole('link', { name: 'Show on map' }).click();
    await page.getByRole('heading', { name: 'Places map', exact: true }).waitFor();
    await expect.poll(() => page.getByLabel('Search names').inputValue()).toBe('+971 2 642 9176');
    await page.locator('#places-details').getByText('Aesop', { exact: true }).first().waitFor();
    expect(problems).toEqual([]);
  });
});
