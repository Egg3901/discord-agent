import type { ContentBlock } from './aiClient.js';

export interface RepoContext {
  repoUrl: string;
  files: { path: string; content: string }[];
}

export function buildSystemPrompt(repoContext?: RepoContext, toolsEnabled?: boolean): string {
  let prompt = `You are a highly skilled software engineering assistant operating through Discord. You help users write, review, debug, and understand code.

Guidelines:
- Provide clear, concise, and correct code solutions.
- If the user's request is ambiguous, ask clarifying questions.
- Keep responses focused and practical.
- When reviewing code, be specific about issues and provide fixes.
- Format responses for Discord (markdown).`;

  // Structured diffs instructions
  prompt += `

When suggesting code changes, use SEARCH/REPLACE blocks instead of showing entire files:

\`\`\`
<<<<<<< SEARCH
[exact lines to find in the original code]
=======
[replacement lines]
>>>>>>> REPLACE
\`\`\`

Rules for SEARCH/REPLACE blocks:
- The SEARCH section must exactly match existing code, including whitespace and indentation.
- Keep SEARCH blocks small and focused — just enough context to uniquely identify the location.
- For new files, show the full file content in a fenced code block (not a SEARCH/REPLACE block).
- For deletions, use an empty REPLACE section.
- When changes span multiple non-adjacent locations, use separate SEARCH/REPLACE blocks for each.`;

  // Tool-use instructions
  if (toolsEnabled) {
    prompt += `

You have tools to explore the attached GitHub repository:
- \`read_file\`: Read the contents of any file in the repo.
- \`list_directory\`: List files and subdirectories at a path.
- \`search_code\`: Search for text patterns across the repo.

Use these tools proactively to explore the codebase before answering questions.
Do not guess at file contents — read them first. When making code changes, read the relevant files to ensure your SEARCH blocks match exactly.`;
  }

  if (repoContext) {
    prompt += `\n\nYou have access to the following repository: ${repoContext.repoUrl}\n`;
    if (repoContext.files.length > 0) {
      prompt += `\nRepository files provided as initial context:\n`;
      for (const file of repoContext.files) {
        prompt += `\n--- ${file.path} ---\n\`\`\`\n${file.content}\n\`\`\`\n`;
      }
    }
  }

  return prompt;
}

/**
 * Estimate token count (rough: ~4 chars per token).
 */
export function estimateTokens(content: string | ContentBlock[]): number {
  if (typeof content === 'string') {
    return Math.ceil(content.length / 4);
  }
  // For content block arrays, stringify and estimate
  const text = content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return JSON.stringify(b.input);
      if (b.type === 'tool_result') return b.content;
      return '';
    })
    .join('');
  return Math.ceil(text.length / 4);
}

/**
 * Trim conversation history to fit within token budget.
 * Keeps system prompt + first message + last N messages.
 */
export function trimConversation(
  messages: { role: 'user' | 'assistant'; content: string | ContentBlock[] }[],
  maxTokens: number,
): { role: 'user' | 'assistant'; content: string | ContentBlock[] }[] {
  if (messages.length === 0) return messages;

  let totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  if (totalTokens <= maxTokens) return messages;

  // Keep first message and trim from the middle
  const result = [messages[0]];
  let usedTokens = estimateTokens(messages[0].content);

  // Add messages from the end until we hit the budget
  const tail: typeof messages = [];
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
