import { createOpenRouterReplyGenerator, GEMINI_REPLY_MODEL, type OpenRouterReplyOptions } from './openrouter-reply-generator.ts';

export { GEMINI_REPLY_MODEL };

export function createGeminiReplyGenerator(options: Omit<OpenRouterReplyOptions, 'model'>) {
  return createOpenRouterReplyGenerator({ ...options, model: GEMINI_REPLY_MODEL });
}
