/** Ordinary model content for tests at the chat-completions transport boundary. */
export function aliReplyContent(text: string): string {
  return JSON.stringify({ case_status: 'MONITORING', should_reply: true, external_reply: text, review_reasons: [], silence_reason: null });
}
