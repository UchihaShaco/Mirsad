/**
 * GET / and GET /assets/* (design section 6): the reference dashboard's files, served from src/dashboard/ under the
 * dashboard Content-Security-Policy. Requests go to a real instance; the traversal attempts use node:http so each path
 * reaches the server exactly as written.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const DASHBOARD_CSP =
  "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const DASHBOARD_DIR = fileURLToPath(new URL('../../src/dashboard/', import.meta.url));
const PACKAGE_JSON_MARKER = '"name": "mirsad"';

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A GET whose request target is sent verbatim (fetch would normalize dot segments and encodings first). */
function rawGet(target: string): Promise<RawResponse> {
  const { hostname, port, host } = new URL(h.baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port, path: target, method: 'GET', headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe('dashboard static files', () => {
  it('serves the page and its assets with the dashboard CSP and their content types', async () => {
    const expected: [string, string][] = [
      ['/', 'text/html; charset=utf-8'],
      ['/assets/styles.css', 'text/css; charset=utf-8'],
      ['/assets/js/main.js', 'text/javascript; charset=utf-8'],
      ['/assets/js/state/composer.js', 'text/javascript; charset=utf-8'],
      ['/assets/js/views/places-map.js', 'text/javascript; charset=utf-8'],
      ['/assets/js/map-slippy.js', 'text/javascript; charset=utf-8'],
      ['/assets/icon.svg', 'image/svg+xml'],
    ];
    for (const [target, contentType] of expected) {
      const res = await fetch(h.baseUrl + target);
      const body = await res.text();
      expect(res.status, target).toBe(200);
      expect(res.headers.get('content-type'), target).toBe(contentType);
      expect(res.headers.get('content-security-policy'), target).toBe(DASHBOARD_CSP);
      expect(res.headers.get('x-content-type-options'), target).toBe('nosniff');
      expect(body.length, target).toBeGreaterThan(0);
    }
    const page = await (await fetch(`${h.baseUrl}/`)).text();
    expect(page).toContain('<script type="module" src="/assets/js/main.js"></script>');
    expect(page).toContain('<link rel="stylesheet" href="/assets/styles.css">');
  });

  it('refuses paths outside the dashboard directory, hidden files and file types it does not serve', async () => {
    const refused = [
      '/assets/../package.json',
      '/assets/%2e%2e/%2e%2e/package.json',
      '/assets/..%2F..%2Fpackage.json',
      '/assets/..%5C..%5Cpackage.json',
      '/assets/js/..\\..\\..\\..\\package.json',
      '/assets/js/state/composer.d.ts',
      '/assets/.env',
      '/assets/js',
      '/assets/',
    ];
    for (const target of refused) {
      const res = await rawGet(target);
      expect(res.status, target).toBeGreaterThanOrEqual(400);
      expect(res.status, target).toBeLessThan(500);
      expect(res.body, target).not.toContain(PACKAGE_JSON_MARKER);
      expect(res.body, target).not.toContain('export function');
    }
  });

  it('the dashboard source never parses markup and the page has no inline script, style, handler or remote asset', () => {
    const files = filesUnder(DASHBOARD_DIR);
    const scripts = files.filter((file) => file.endsWith('.js'));
    expect(scripts.length).toBeGreaterThan(5);
    for (const file of scripts) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
      // The officer can explicitly open a composed first message in Telegram. No remote assets are loaded.
      const withoutHandoff = path.relative(DASHBOARD_DIR, file).split(path.sep).join('/') === 'js/views/phone-dispatch.js'
        ? source.replace("new URL('https://t.me/' + recipient)", '')
        : source;
      expect(withoutHandoff, file).not.toMatch(/https?:\/\//);
    }
    const page = fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html'), 'utf8');
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/<style|\sstyle\s*=/i);
    expect(page).not.toMatch(/https?:\/\//);
    const styles = fs.readFileSync(path.join(DASHBOARD_DIR, 'styles.css'), 'utf8');
    expect(styles).not.toMatch(/@import|url\(/);
  });
});
