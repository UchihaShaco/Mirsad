/** Check the same Gemini decision path as Telegram with invented input. Emit only fixed status and error codes. */
import { fileURLToPath } from 'node:url';
import { createGeminiReplyGenerator } from '../src/replies/gemini-reply-generator.ts';
import { ReplyGenerationError } from '../src/replies/reply-generator.ts';
import { isEntryPoint, loadDotEnvIfPresent } from './entry-point.ts';

const PROBES = [
  { id: 'greeting', text: 'Hello!', expected: 'REPLY' },
  { id: 'opt_out', text: 'Please stop messaging me.', expected: 'SILENCE' },
  {
    id: 'officer_review', expected: 'READY_FOR_OFFICER_REVIEW',
    text: 'I offer paid shifts packing boxes. I said there were no fees. Actually, pay me an upfront fee right now or lose the offer in five minutes. A separate payment request will come from a different merchant whose identity I cannot verify.',
  },
] as const;

export async function runAssessmentPreview(
  apiKey: string | undefined, request: typeof fetch = fetch, write: (line: string) => void = console.log,
): Promise<number> {
  const key = apiKey?.trim();
  if (!key) {
    write('FAIL setup KEY_MISSING');
    return 1;
  }
  const generator = createGeminiReplyGenerator({ apiKey: key, timeoutMs: 60_000, fetch: request });
  for (const probe of PROBES) {
    try {
      const decision = await generator.decide([{ from: 'contact', text: probe.text }], new AbortController().signal);
      const outcome = decision.kind === 'review' ? decision.status : decision.kind.toUpperCase();
      if (outcome !== probe.expected) {
        write(`FAIL ${probe.id} UNEXPECTED_DECISION`);
        return 1;
      }
      write(`PASS ${probe.id} ${outcome}`);
    } catch (error) {
      const code = error instanceof ReplyGenerationError ? error.code.toUpperCase() : 'UNEXPECTED_ERROR';
      write(`FAIL ${probe.id} ${code}`);
      return 1;
    }
  }
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('FAIL setup UNEXPECTED_ARGUMENTS');
    process.exitCode = 1;
  } else {
    try {
      loadDotEnvIfPresent(fileURLToPath(new URL('../.env', import.meta.url)));
      process.exitCode = await runAssessmentPreview(process.env.OPENROUTER_API_KEY);
    } catch {
      console.error('FAIL setup CONFIGURATION');
      process.exitCode = 1;
    }
  }
}
