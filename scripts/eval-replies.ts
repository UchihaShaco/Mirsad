/** Replay fixed synthetic conversations against the loopback reply model. No inbox, database or Telegram transport. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import {
  createLmStudioReplyGenerator, REPLY_SYSTEM_PROMPT, ReplyGenerationError,
  type ReplyGenerator,
} from '../src/replies/reply-generator.ts';
import { blockedRuleForTurn, correctionFor, type ReplyGuardRule } from '../src/replies/reply-guard.ts';
import { hasAnsweredIdentityRepeat } from '../src/replies/reply-duplicates.ts';
import type { AliDecision } from '../src/replies/ali-decision.ts';
import { isEntryPoint } from './entry-point.ts';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../fixtures/eval-replies');
const SetName = z.enum(['dev', 'heldout', 'all', 'offers']);
const Args = z.object({ set: SetName, out: z.string().min(1).optional() });
const Scenario = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  category: z.string().min(1),
  criteria: z.string().min(1),
  first: z.boolean(),
  held: z.boolean(),
  history: z.array(z.strictObject({ from: z.enum(['contact', 'owner']), text: z.string().min(1) }))
    .min(1).refine(history => history.at(-1)?.from === 'contact', 'expected a final incoming turn'),
});
const Deck = z.array(Scenario).min(1).refine(cases => new Set(cases.map(item => item.id)).size === cases.length, 'duplicate scenario id');
type Scenario = z.infer<typeof Scenario>;
type Attempt = { instructionsSha256: string } & (
  | { draft: string | null; blockedBy: ReplyGuardRule | null }
  | { error: ReplyGenerationError['code'] }
);
type Status = 'reply' | 'silence' | 'review' | 'blocked' | 'error';
type Result = Scenario & {
  status: Status; source: 'model'; delivery: string | null; attempts: Attempt[];
  error?: string; silenceReason?: 'answered_identity_repeat';
  review?: Extract<AliDecision, { kind: 'review' }>;
};

export async function runCase(scenario: Scenario, generator: ReplyGenerator): Promise<Result> {
  const attempts: Attempt[] = [];
  const result = { ...scenario, source: 'model' as const, delivery: null, attempts };
  const currentTurn = scenario.history.slice(scenario.history.findLastIndex(turn => turn.from === 'owner') + 1).map(turn => turn.text);
  let correction: string | undefined;
  const instructionsSha256 = createHash('sha256').update(REPLY_SYSTEM_PROMPT).digest('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    let draft: string | null;
    try {
      const signal = new AbortController().signal;
      if (generator.decide) {
        const decision = await generator.decide(scenario.history, signal, correction, currentTurn);
        if (decision.kind === 'review') {
          attempts.push({ draft: null, blockedBy: null, instructionsSha256 });
          return { ...result, status: 'review', review: decision };
        }
        draft = decision.kind === 'reply' ? decision.text : null;
      } else {
        draft = await generator.generate(scenario.history, signal, correction, currentTurn);
      }
    } catch (error) {
      if (!(error instanceof ReplyGenerationError)) throw error;
      attempts.push({ error: error.code, instructionsSha256 });
      return { ...result, status: 'error', error: error.code };
    }
    if (draft !== null && hasAnsweredIdentityRepeat(scenario.history, currentTurn)) {
      attempts.push({ draft, blockedBy: null, instructionsSha256 });
      return { ...result, status: 'silence', silenceReason: 'answered_identity_repeat' };
    }
    const blockedBy = draft === null ? null : blockedRuleForTurn(draft, scenario.history, currentTurn);
    attempts.push({ draft, blockedBy, instructionsSha256 });
    if (draft === null) return { ...result, status: 'silence' };
    if (blockedBy === null) return { ...result, status: 'reply', delivery: draft };
    correction = correctionFor(blockedBy);
  }
  return { ...result, status: 'blocked' };
}

export async function runReplyEval(
  argv: string[], fetchModel: typeof fetch = fetch, write: (line: string) => void = console.log,
): Promise<number> {
  let args: z.infer<typeof Args>;
  try {
    const { values } = parseArgs({ args: argv, options: { set: { type: 'string', default: 'dev' }, out: { type: 'string' } } });
    args = Args.parse(values);
  } catch {
    write('Usage: npm run eval:replies -- --set dev|heldout|all|offers [--out report.json]');
    return 2;
  }
  const source = fs.readFileSync(path.join(FIXTURES_DIR, args.set === 'offers' ? 'offers.json' : 'scenarios.json'));
  const deck = Deck.parse(JSON.parse(source.toString('utf8')));
  const selected = args.set === 'all' || args.set === 'offers' ? deck : deck.filter(item => item.held === (args.set === 'heldout'));
  const modelSettings = loadConfig({}).lmStudio;
  const generator = createLmStudioReplyGenerator({ ...modelSettings, fetch: fetchModel });
  const results: Result[] = [];
  const counts = { reply: 0, silence: 0, review: 0, blocked: 0, error: 0 };
  const promptSha256 = createHash('sha256').update(REPLY_SYSTEM_PROMPT).digest('hex');
  write(`model=${generator.model} set=${args.set} cases=${selected.length} promptSha256=${promptSha256}`);
  for (const scenario of selected) {
    const result = await runCase(scenario, generator);
    results.push(result);
    counts[result.status]++;
    write(`${scenario.id} ${result.status}${result.error ? ' ' + result.error : ''}`);
  }
  const modelCases = results.length;
  const modelCalls = results.reduce((total, result) => total + result.attempts.length, 0);
  const retries = modelCalls - modelCases;
  if (args.out) {
    const report = {
      set: args.set, model: generator.model, contextTokens: modelSettings.contextTokens, generatedAt: new Date().toISOString(),
      promptSha256, deckSha256: createHash('sha256').update(source).digest('hex'), counts, modelCases, modelCalls, retries, results,
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
  }
  write(`Outcomes ${JSON.stringify(counts)}. ${modelCalls} model calls for ${modelCases} cases, including ${retries} retries. Assess the responses against the scenario criteria.`);
  return counts.error > 0 ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) {
  runReplyEval(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Reply evaluation failed to read fixtures, run inference, or write the report.');
    process.exitCode = 1;
  });
}
