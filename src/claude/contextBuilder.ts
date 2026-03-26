export interface RepoContext {
  repoUrl: string;
  files: { path: string; content: string }[];
}

export function buildSystemPrompt(repoContext?: RepoContext): string {
  let prompt = `You are a highly skilled software engineering assistant operating through Discord. You help users write, review, debug, and understand code.

Guidelines:
- Provide clear, concise, and correct code solutions.
- When showing code changes, use fenced code blocks with the language specified.
- If the user's request is ambiguous, ask clarifying questions.
- Keep responses focused and practical.
- When reviewing code, be specific about issues and provide fixes.
- Format responses for Discord (markdown).`;

  if (repoContext) {
    prompt += `\n\nYou have access to the following repository: ${repoContext.repoUrl}\n`;
    prompt += `\nRepository files provided as context:\n`;
    for (const file of repoContext.files) {
      prompt += `\n--- ${file.path} ---\n\`\`\`\n${file.content}\n\`\`\`\n`;
    }
  }

  return prompt;
}

/**
 * Estimate token count (rough: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Trim conversation history to fit within token budget.
 * Keeps system prompt + first message + last N messages.
 */
export function trimConversation(
  messages: { role: 'user' | 'assistant'; content: string }[],
  maxTokens: number,
): { role: 'user' | 'assistant'; content: string }[] {
  if (messages.length === 0) return messages;

  let totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  if (totalTokens <= maxTokens) return messages;

  // Keep first message and trim from the middle
  const result = [messages[0]];
  let usedTokens = estimateTokens(messages[0].content);

  // Add messages from the end until we hit the budget
  const tail: { role: 'user' | 'assistant'; content: string }[] = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    const tokens = estimateTokens(messages[i].content);
    if (usedTokens + tokens > maxTokens) break;
    tail.unshift(messages[i]);
    usedTokens += tokens;
  }

  if (tail.length < messages.length - 1) {
    result.push({
      role: 'user' as const,
      content: '[Earlier messages were trimmed to fit context window]',
    });
  }

  result.push(...tail);
  return result;
}
