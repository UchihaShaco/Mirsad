/**
 * `npm run eval:model -- --set dev|heldout [--reviewer lmstudio|deterministic]`: reviews every incoming message of a
 * synthetic evaluation set from fixtures/eval/, checks each item with validateItem, scores the run and writes
 * docs/evaluation/<set>-<reviewer>-latest.json and .md. Both hold counts, IDs and timings only, never message text.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { createJsonLogger } from '../src/logging/json-logger.ts';
import { ReviewerUnavailableError, type Reviewer } from '../src/ports/reviewer.ts';
import {
  LANGUAGES,
  scoreTranscripts,
  type EvalReport,
  type GroupScore,
  type Language,
  type MessageScore,
  type ReviewedMessage,
  type TranscriptResult,
} from '../src/review/eval/metrics.ts';
import { Transcript, type TranscriptMessage } from '../src/review/eval/transcript-schema.ts';
import { createReviewer } from '../src/review/reviewer-factory.ts';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES_DIR = path.join(PROJECT_ROOT, 'fixtures', 'eval');
const REPORT_DIR = path.join(PROJECT_ROOT, 'docs', 'evaluation');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const USAGE = 'usage: npm run eval:model -- --set dev|heldout [--reviewer lmstudio|deterministic]';
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const LANGUAGE_NAMES: Record<Language, string> = { ar: 'Arabic', en: 'English', mixed: 'Mixed' };

const Args = z.object({ set: z.enum(['dev', 'heldout']), reviewer: z.enum(['lmstudio', 'deterministic']) });
type Args = z.infer<typeof Args>;

interface EvalDocument extends EvalReport {
  set: Args['set'];
  reviewer: Args['reviewer'];
  modelId: string | null;
  generatedAt: string;
  transcripts: string[];
}

function parseCommandLine(argv: string[]): Args | null {
  try {
    const { values } = parseArgs({ args: argv, options: { set: { type: 'string' }, reviewer: { type: 'string', default: 'lmstudio' } } });
    const parsed = Args.safeParse(values);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Reads and checks one transcript file; problems name the file and field, never its text. */
function readTranscript(set: string, file: string): Transcript {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, set, file), 'utf8'));
  } catch {
    throw new Error(`${set}/${file} is not readable JSON`);
  }
  const parsed = Transcript.safeParse(raw);
  if (!parsed.success) throw new Error(`${set}/${file} is not a transcript: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const ids = parsed.data.messages.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${set}/${file} repeats a message id`);
  return parsed.data;
}

function loadTranscripts(set: Args['set']): Transcript[] {
  const files = fs.readdirSync(path.join(FIXTURES_DIR, set)).filter((name) => name.endsWith('.json')).sort();
  const transcripts = files.map((file) => readTranscript(set, file));
  const ids = transcripts.map((t) => t.id);
  if (new Set(ids).size !== ids.length) throw new Error(`the ${set} set repeats a transcript id`);
  return transcripts;
}

/** The service's own reviewer for this kind, with the LM Studio settings from .env and the environment. */
function buildReviewer(kind: Args['reviewer']): Reviewer {
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const config = loadConfig(process.env);
  return createReviewer({ ...config, reviewer: kind }, createJsonLogger({ write: (line) => process.stderr.write(`${line}\n`) }));
}

/** A message ID shaped like the service's (msg_ and 32 hex digits), so echoing it is as hard as in production. */
function reviewedMessageId(transcriptId: string, messageId: string): string {
  return `msg_${createHash('sha256').update(`${transcriptId}/${messageId}`).digest('hex').slice(0, 32)}`;
}

async function reviewMessage(reviewer: Reviewer, transcript: Transcript, message: TranscriptMessage): Promise<ReviewedMessage> {
  const id = reviewedMessageId(transcript.id, message.id);
  const request = { reviewId: `eval_${id}`, chatId: transcript.id, messageId: id, messageEventId: id, source: 'telegram' as const, text: message.text };
  const started = performance.now();
  const answer = await reviewer.review(request, new AbortController().signal).then(
    ({ items }) => ({ items }),
    (error: unknown) => ({ errorCode: error instanceof ReviewerUnavailableError ? error.code : 'reviewer_failed' }),
  );
  return { messageId: message.id, reviewedMessageId: id, answer, latencyMs: Math.round(performance.now() - started) };
}

/** One message at a time, so each latency is the model's own answer time. */
async function reviewAll(reviewer: Reviewer, transcripts: readonly Transcript[]): Promise<TranscriptResult[]> {
  const results: TranscriptResult[] = [];
  for (const transcript of transcripts) {
    const reviews: ReviewedMessage[] = [];
    for (const message of transcript.messages.filter((m) => m.direction === 'incoming')) {
      reviews.push(await reviewMessage(reviewer, transcript, message));
    }
    results.push({ transcript, reviews });
  }
  return results;
}

const percent = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const millis = (value: number | null): string => (value === null ? 'n/a' : String(Math.round(value)));
const kinds = (list: readonly string[]): string => (list.length === 0 ? '-' : list.join(', '));

function groupRow(name: string, group: GroupScore): string {
  const { latency, concernAgreement } = group;
  const timing = [latency.minMs, latency.medianMs, latency.p95Ms, latency.maxMs].map(millis).join(' / ');
  const cells = [name, group.messages, group.unavailable, group.truePositives, group.falsePositives, group.falseNegatives];
  const rates = [percent(group.precision), percent(group.recall), group.unsupported, `${concernAgreement.agreeing} of ${concernAgreement.matchedPhones}`];
  return `| ${[...cells, ...rates, timing].join(' | ')} |`;
}

function messageRow(score: MessageScore): string {
  const counts = [score.expected, score.truePositives, score.falsePositives, score.falseNegatives, score.unsupported];
  const cells = [score.transcriptId, score.messageId, score.language, ...counts, kinds(score.missedKinds), kinds(score.extraKinds)];
  return `| ${[...cells, score.latencyMs, score.errorCode ?? '-'].join(' | ')} |`;
}

function renderMarkdown(doc: EvalDocument): string {
  return [
    `# Evaluation: ${doc.set} set, ${doc.reviewer} reviewer`,
    '',
    `Generated ${doc.generatedAt}. Model: ${doc.modelId ?? 'none'}. Transcripts: ${doc.transcripts.length}. Incoming messages reviewed: ${doc.overall.messages}.`,
    '',
    'Synthetic transcripts only. This report holds counts, IDs and timings, never message text or extracted values. See README.md in this folder for how to read it.',
    '',
    '| Group | Messages | Unavailable | TP | FP | FN | Precision | Recall | Unsupported | Concern agreement | Latency min / median / p95 / max (ms) |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    groupRow('Overall', doc.overall),
    ...LANGUAGES.map((language) => groupRow(LANGUAGE_NAMES[language], doc.byLanguage[language])),
    '',
    '## Messages',
    '',
    '| Transcript | Message | Language | Expected | TP | FP | FN | Unsupported | Missed | Extra | Latency (ms) | Error |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...doc.messages.map(messageRow),
    '',
  ].join('\n');
}

function writeReports(doc: EvalDocument): string {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const base = path.join(REPORT_DIR, `${doc.set}-${doc.reviewer}-latest`);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(`${base}.md`, renderMarkdown(doc));
  return path.relative(PROJECT_ROOT, base).replaceAll('\\', '/');
}

function summaryLine(doc: EvalDocument): string {
  const { overall: o } = doc;
  const counts = `TP ${o.truePositives}, FP ${o.falsePositives}, FN ${o.falseNegatives}, unsupported ${o.unsupported}, unavailable ${o.unavailable}`;
  const rates = `precision ${percent(o.precision)}, recall ${percent(o.recall)}`;
  return `${doc.set}/${doc.reviewer}: ${o.messages} messages, ${counts}, ${rates}, median ${millis(o.latency.medianMs)} ms, p95 ${millis(o.latency.p95Ms)} ms`;
}

async function main(): Promise<number> {
  const args = parseCommandLine(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  const transcripts = loadTranscripts(args.set);
  const reviewer = buildReviewer(args.reviewer);
  const health = (await reviewer.health?.()) ?? { reachable: true, modelId: null };
  if (!health.reachable) {
    process.stderr.write(`the ${args.reviewer} reviewer is not reachable, or its configured model is not loaded\n`);
    return EXIT_FAILED;
  }
  const report = scoreTranscripts(await reviewAll(reviewer, transcripts));
  const doc: EvalDocument = {
    set: args.set,
    reviewer: args.reviewer,
    modelId: health.modelId,
    generatedAt: new Date().toISOString(),
    transcripts: transcripts.map((t) => t.id),
    ...report,
  };
  const written = writeReports(doc);
  process.stdout.write(`${summaryLine(doc)}\nwrote ${written}.json and ${written}.md\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Messages here name files, fields and settings (a ConfigError names its variable), never transcript text.
    process.stderr.write(`eval failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = EXIT_FAILED;
  },
);
