/** Fixture validation and HTTP replay of synthetic Telegram fixtures (design section 13). */
import { nonReservedPhones } from '../domain/reserved-numbers.ts';
import { createTelegramAdapter } from './telegram/normalize.ts';
import { SYNTHETIC_MARK_PROBLEM, telegramFixtureSchema } from './telegram/fixture-schema.ts';
import type { TelegramUpdate } from './telegram/types.ts';

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
const URL_HOST = /https?:\/\/([^\s/:?#]+)/gi;
const EMAIL_HOST = /[\w.+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const BARE_HOST = /(?<![\p{L}\p{N}_-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}_-])/giu;

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

/** The same reserved-number check as the held-out evaluation fixtures (src/domain/reserved-numbers.ts). */
function phoneProblems(text: string): string[] {
  return nonReservedPhones(text).map((span) => `non-reserved phone number: ${span}`);
}

function structureProblems(fixture: unknown): string[] {
  const parsed = telegramFixtureSchema.safeParse(fixture);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const where = issue.path.join('.');
    return where === '' || issue.message === SYNTHETIC_MARK_PROBLEM ? issue.message : `${where}: ${issue.message}`;
  });
}

/** Returns problems; empty when the file is well-formed, synthetic and uses only reserved domains and phone ranges. */
export function validateFixture(fixture: unknown): string[] {
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) return ['fixture must be a JSON object'];
  const problems = structureProblems(fixture);
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
export async function replayFixture(input: unknown, options: ReplayOptions): Promise<ReplayReport> {
  const problems = validateFixture(input);
  if (problems.length > 0) throw new Error(`replay refused: ${problems.join('; ')}`);
  const fixture = telegramFixtureSchema.parse(input);
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
    const envelopes = adapter.normalize(update as TelegramUpdate);
    if (envelopes.length === 0) skippedUpdates += 1;
    for (const envelope of envelopes) events.push(await postEnvelope(doFetch, options, envelope));
  }
  return { events, skippedUpdates };
}
