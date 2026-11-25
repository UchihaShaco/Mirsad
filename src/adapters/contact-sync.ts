/**
 * HTTP client for the contact-sync server's admin API (mirsad-contact-sync/): POST /api/v1/scammers upserts a number,
 * PATCH /api/v1/scammers/{phone} with {active:false} deactivates it and keeps its history. Every call has a timeout
 * and answers an outcome; nothing here throws. The URL is fixed by configuration and sits on a loopback host.
 */
import type { Config } from '../config.ts';
import type { ContactSyncOutcome, ContactSyncPublisher } from '../ports/contact-sync.ts';

const DEFAULT_TIMEOUT_MS = 5000;
const NOT_FOUND = 404;

export interface ContactSyncClientOptions {
  config: NonNullable<Config['contactSync']>;
  timeoutMs?: number;
}

/** 401/403 mean the token; another 4xx means the server will refuse this number however often it is sent. */
function failureOf(status: number): ContactSyncOutcome {
  if (status === 401 || status === 403) return { ok: false, code: 'token_refused', retry: false };
  if (status < 500) return { ok: false, code: 'number_refused', retry: false };
  return { ok: false, code: 'server_error', retry: true };
}

export function createContactSyncClient(options: ContactSyncClientOptions): ContactSyncPublisher {
  const { url, token, label, source } = options.config;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) };

  async function send(method: 'POST' | 'PATCH', path: string, body: object, absentIsDone = false): Promise<ContactSyncOutcome> {
    try {
      const res = await fetch(`${url}${path}`, { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel();
      return res.ok || (absentIsDone && res.status === NOT_FOUND) ? { ok: true } : failureOf(res.status);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return { ok: false, code: timedOut ? 'timeout' : 'unreachable', retry: true };
    }
  }

  return {
    publish: (e164, reference) => send('POST', '/api/v1/scammers', { phone: e164, active: true, label, source, note: `Mirsad watchlist entry ${reference}` }),
    withdraw: (e164) => send('PATCH', `/api/v1/scammers/${encodeURIComponent(e164)}`, { active: false }, true),
  };
}
