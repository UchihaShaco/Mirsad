/**
 * GET / and GET /assets/* (design section 6): the reference dashboard's static files. Only regular files inside
 * src/dashboard/ whose every path segment is plain (letters, digits, '.', '_', '-', never starting with a dot) and whose
 * extension has a known content type are served, each under the dashboard Content-Security-Policy. Anything else,
 * including any form of path traversal, is 404. Files are read on each request: the dashboard has no build step.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import { fail } from '../../contract/errors.ts';
import type { AppEnv, RouteModule } from '../context.ts';

const DASHBOARD_CSP =
  "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const DASHBOARD_ROOT = fileURLToPath(new URL('../../dashboard/', import.meta.url));

const INDEX_FILE = 'index.html';
const ASSET_PREFIX = '/assets/';
const MAX_ASSET_PATH_LENGTH = 200;
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);
const OK = 200;
const NOT_FOUND = 404;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function contentTypeOf(file: string): string | null {
  const extension = path.extname(file).toLowerCase();
  return Object.hasOwn(CONTENT_TYPES, extension) ? (CONTENT_TYPES[extension] ?? null) : null;
}

/** Maps a request path under /assets/ to a file inside the dashboard directory, or null when it may not be served. */
function resolveAssetPath(requestPath: string): string | null {
  if (!requestPath.startsWith(ASSET_PREFIX)) return null;
  const relative = requestPath.slice(ASSET_PREFIX.length);
  if (relative.length === 0 || relative.length > MAX_ASSET_PATH_LENGTH) return null;
  const segments = relative.split('/');
  if (!segments.every((segment) => SAFE_SEGMENT.test(segment)) || contentTypeOf(relative) === null) return null;
  const resolved = path.resolve(DASHBOARD_ROOT, ...segments);
  const inside = path.relative(DASHBOARD_ROOT, resolved);
  return inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside) ? resolved : null;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && MISSING_FILE_CODES.has(String(error.code));
}

/** The file's bytes when it is a regular file, null when it does not exist; other read errors propagate (500). */
async function readRegularFile(file: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const stats = await fs.stat(file);
    return stats.isFile() ? new Uint8Array(await fs.readFile(file)) : null;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function notFound(c: Context<AppEnv>): Response {
  return c.json(fail({ code: 'not_found', message: 'No such dashboard file.' }), NOT_FOUND, {
    'Content-Security-Policy': DASHBOARD_CSP,
  });
}

async function serveFile(c: Context<AppEnv>, file: string | null): Promise<Response> {
  const contentType = file === null ? null : contentTypeOf(file);
  const bytes = file === null || contentType === null ? null : await readRegularFile(file);
  if (bytes === null || contentType === null) return notFound(c);
  return c.body(bytes, OK, { 'Content-Type': contentType, 'Content-Security-Policy': DASHBOARD_CSP });
}

export const routes: RouteModule = {
  'GET /': (c) => serveFile(c, path.join(DASHBOARD_ROOT, INDEX_FILE)),
  'GET /assets/*': (c) => serveFile(c, resolveAssetPath(c.req.path)),
};
