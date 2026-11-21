/** Fixture validation and HTTP replay of synthetic Telegram fixtures (design section 13). */
import { createTelegramAdapter } from './telegram/normalize.ts';
import type { TelegramFixture } from './telegram/types.ts';

export type FixtureAccount = 'intake' | 'officer';

export interface ReplayOptions {
  baseUrl: string;
  connectorToken: string;
  accounts: Record<FixtureAccount, string>;
  fetch?: typeof fetch;
}

export interface ReplayEventReport {
  sourceEventId: string;
  status: number;
  /** `IngestResult.result` on success, the error code otherwise. */
  result: string;
  chatId: string | null;
  messageId: string | null;
}

export interface ReplayReport {
  events: ReplayEventReport[];
  /** Updates that produced no intake event (other connection, business_connection, message id 0). */
  skippedUpdates: number;
}

const RESERVED_TLDS = ['test', 'example', 'invalid'];
const EXAMPLE_LABEL = 'example';
const MIN_PHONE_DIGITS = 9;
const UK_FICTIONAL = /^(?:44|0)7700900\d{3}$/;
const US_FICTIONAL = /^1\d{3}55501\d{2}$/;
const URL_HOST = /https?:\/\/([^\s/:?#]+)/gi;
const EMAIL_HOST = /[\w.+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const BARE_HOST = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;
const PHONE_LIKE = /\+?\d[\d\s().-]{7,}\d/g;

function isReservedHost(host: string): boolean {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (RESERVED_TLDS.includes(tld)) return true;
  return labels.length >= 2 && labels[labels.length - 2] === EXAMPLE_LABEL;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, out));
}

function domainProblems(text: string): string[] {
  const hosts = new Set<string>();
  for (const pattern of [URL_HOST, EMAIL_HOST, BARE_HOST]) {
    for (const match of text.matchAll(pattern)) hosts.add(match[1] ?? match[0]);
  }
  return [...hosts].filter((host) => !isReservedHost(host)).map((host) => `non-reserved domain: ${host}`);
}

function phoneProblems(text: string): string[] {
  const problems: string[] = [];
  for (const match of text.matchAll(PHONE_LIKE)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length < MIN_PHONE_DIGITS) continue;
    if (!UK_FICTIONAL.test(digits) && !US_FICTIONAL.test(digits)) problems.push(`non-reserved phone number: ${match[0]}`);
  }
  return problems;
}

function structureProblems(fixture: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (fixture.synthetic !== true) problems.push('fixture is not marked synthetic: true');
  if (typeof fixture.description !== 'string' || fixture.description === '') problems.push('fixture has no description');
  if (fixture.account !== 'intake' && fixture.account !== 'officer') problems.push("account must be 'intake' or 'officer'");
  if (typeof fixture.businessUserId !== 'number') problems.push('businessUserId must be a number');
  if (typeof fixture.businessConnectionId !== 'string') problems.push('businessConnectionId must be a string');
  if (!Array.isArray(fixture.updates)) problems.push('updates must be an array');
  return problems;
}

/** Returns problems; empty when the file is synthetic and uses only reserved domains and phone ranges. */
export function validateFixture(fixture: unknown): string[] {
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) return ['fixture must be a JSON object'];
  const problems = structureProblems(fixture as Record<string, unknown>);
  const strings: string[] = [];
  collectStrings(fixture, strings);
  const content = [...new Set(strings.flatMap((s) => [...domainProblems(s), ...phoneProblems(s)]))];
  return [...problems, ...content];
}

interface IngestEnvelopeBody {
  success?: boolean;
  data?: { chatId?: string; messageId?: string; result?: string } | null;
  error?: { code?: string } | null;
}

async function postEnvelope(
  doFetch: typeof fetch,
  options: ReplayOptions,
  envelope: ReturnType<ReturnType<typeof createTelegramAdapter>['normalize']>[number],
): Promise<ReplayEventReport> {
  const response = await doFetch(`${options.baseUrl}/v1/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.connectorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  let body: IngestEnvelopeBody | null = null;
  try {
    body = (await response.json()) as IngestEnvelopeBody;
  } catch {
    body = null;
  }
  return {
    sourceEventId: envelope.event.sourceEventId,
    status: response.status,
    result: body?.data?.result ?? body?.error?.code ?? 'unparseable_response',
    chatId: body?.data?.chatId ?? null,
    messageId: body?.data?.messageId ?? null,
  };
}

/** Posts a validated fixture to POST /v1/ingest one envelope at a time. Reports ids and result codes only. */
export async function replayFixture(fixture: TelegramFixture, options: ReplayOptions): Promise<ReplayReport> {
  const problems = validateFixture(fixture);
  if (problems.length > 0) throw new Error(`replay refused: ${problems.join('; ')}`);
  const accountId = options.accounts[fixture.account];
  if (!accountId) throw new Error(`replay refused: no account mapped for '${fixture.account}'`);
  const adapter = createTelegramAdapter({
    businessUserId: fixture.businessUserId,
    businessConnectionId: fixture.businessConnectionId,
    externalAccountId: accountId,
    ...(fixture.conversationStarts ? { conversationStarts: fixture.conversationStarts } : {}),
  });
  const doFetch = options.fetch ?? fetch;
  const events: ReplayEventReport[] = [];
  let skippedUpdates = 0;
  for (const update of fixture.updates) {
    const envelopes = adapter.normalize(update);
    if (envelopes.length === 0) skippedUpdates += 1;
    for (const envelope of envelopes) events.push(await postEnvelope(doFetch, options, envelope));
  }
  return { events, skippedUpdates };
}
