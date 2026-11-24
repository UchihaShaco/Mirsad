/** Verify bilingual replies and seller recall through OpenRouter without opening Mirsad's inbox. */
import { createOpenRouterReplyGenerator, GEMINI_REPLY_MODEL, OPENROUTER_REPLY_MODELS, OpenRouterReplyError } from '../src/replies/openrouter-reply-generator.ts';
import { publicReplyFromDecision } from '../src/replies/ali-decision.ts';
import { ReplyGenerationError, type ReplyOfferMemory, type ReplyTurn } from '../src/replies/reply-generator.ts';
import { blockedRuleForTurn } from '../src/replies/reply-guard.ts';
import { isEntryPoint, loadDotEnvIfPresent } from './entry-point.ts';

interface Probe {
  label: string;
  history: ReplyTurn[];
  accepts: (reply: string) => boolean;
  memory?: ReplyOfferMemory;
}

function identifiesSender(reply: string): boolean {
  const text = reply.toLowerCase().replace(/[’‘]/gu, "'");
  if (/^(?:the sender|the other party)(?: did| offered (?:it|the chair))?[.!]?$/u.test(text)) return true;
  if (/\bi (?:also )?(?:offered|sold|did)\b(?! not)|\bi was the seller\b|\byou (?:never|didn't|did not)\b/u.test(text)) return false;
  return /\byou (?:did|offered|were (?:the (?:one|seller)|selling|offering)|made the offer)\b|\byou (?:originally|first|initially) offered\b|\b(?:it was you|you were the one|offer (?:was yours|came from you))\b|^you[.!]?$/u.test(text);
}

const probes: Probe[] = [
  {
    label: 'english', accepts: reply => /\bAli\b/u.test(reply),
    history: [
      { from: 'contact', text: 'عندي مصباح للبيع.' },
      { from: 'owner', text: 'شو حجمه؟' },
      { from: 'contact', text: 'What is your first name?' },
    ],
  },
  {
    label: 'emirati_arabic', accepts: reply => /علي/u.test(reply),
    history: [
      { from: 'contact', text: 'I have a stool for sale.' },
      { from: 'owner', text: 'How big is it?' },
      { from: 'contact', text: 'شو اسمك؟' },
    ],
  },
  {
    label: 'seller_memory', accepts: identifiesSender,
    memory: { offer: 'عندي كرسي خشبي للبيع.' },
    history: [
      { from: 'contact', text: 'تعال نكمل بالإنجليزي.' },
      { from: 'owner', text: 'Sure.' },
      { from: 'contact', text: 'Which of us offered the chair earlier? A short answer like “you did” or “I did” is fine.' },
    ],
  },
];

export async function runOpenRouterVerify(
  env: NodeJS.ProcessEnv, fetchModel: typeof fetch = fetch, write: (line: string) => void = console.log,
): Promise<number> {
  const selected = env.MIRSAD_OPENROUTER_MODEL?.trim() || GEMINI_REPLY_MODEL;
  const model = OPENROUTER_REPLY_MODELS.find(id => id === selected);
  if (!model) {
    write('FAIL openrouter_unknown_model');
    return 1;
  }
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    const code = model === GEMINI_REPLY_MODEL ? 'gemini_key_missing' : 'openrouter_key_missing';
    write(`FAIL ${code} — set OPENROUTER_API_KEY in .env`);
    return 1;
  }
  const generator = createOpenRouterReplyGenerator({ model, apiKey, timeoutMs: 60_000, fetch: fetchModel });
  for (const { label, accepts, history, memory } of probes) {
    const currentTurn = [history.at(-1)!.text];
    try {
      const decision = await generator.decide(history, new AbortController().signal, undefined, currentTurn, memory);
      const reply = publicReplyFromDecision(decision);
      if (!reply || !accepts(reply) || blockedRuleForTurn(reply, history, currentTurn, memory)) {
        write(`FAIL ${label} unexpected_reply`);
        return 1;
      }
      write(`PASS ${label}`);
    } catch (error) {
      const code = error instanceof ReplyGenerationError || error instanceof OpenRouterReplyError ? error.code : 'unexpected_error';
      write(`FAIL ${label} ${code}`);
      return 1;
    }
  }
  return 0;
}

export function runGeminiVerify(
  env: NodeJS.ProcessEnv, fetchModel: typeof fetch = fetch, write: (line: string) => void = console.log,
): Promise<number> {
  return runOpenRouterVerify({ ...env, MIRSAD_OPENROUTER_MODEL: GEMINI_REPLY_MODEL }, fetchModel, write);
}

if (isEntryPoint(import.meta.url)) {
  try {
    loadDotEnvIfPresent();
    const verify = process.argv.includes('--configured-model') ? runOpenRouterVerify : runGeminiVerify;
    process.exitCode = await verify(process.env);
  } catch {
    console.error('FAIL openrouter_verification_setup');
    process.exitCode = 1;
  }
}
