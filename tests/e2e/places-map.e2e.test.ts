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
import { loadPlaces } from '../../src/places/store.ts';
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
  skipReason = `Skipped: neither Microsoft Edge nor Google Chrome could be launched by playwright-core (${failures.join('; ')}).`;
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
  h = await startHarness({ places: loadPlaces(sample), mapTileUpstream: `http://127.0.0.1:${upstreamPort}` });
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
  await page.getByRole('heading', { name: 'New inbound', exact: true }).waitFor();
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
});
