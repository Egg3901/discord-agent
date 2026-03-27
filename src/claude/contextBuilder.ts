import type { ContentBlock } from './aiClient.js';

export interface RepoContext {
  repoUrl: string;
  files: { path: string; content: string }[];
}

export function buildSystemPrompt(repoContext?: RepoContext, toolsEnabled?: boolean, scriptEnabled?: boolean, devToolsEnabled?: boolean): string {
  let prompt = `You are a software engineering assistant on Discord. Write, edit, review, debug, and explain code in any language.

**Response style — this is critical:**
- Be concise. Lead with the answer or code, not preamble.
- Use short messages. Break long responses into multiple shorter messages when possible.
- Use Discord markdown: \`\`\`lang for code blocks, **bold** for emphasis, \`inline code\` for identifiers.
- Don't repeat back what the user said. Just do it.
- Skip filler phrases ("Sure!", "Great question!", "Let me explain...").
- Only elaborate when asked or when the situation is genuinely complex.
- When showing code, always use fenced code blocks with the language tag.`;

  // Structured diffs instructions
  prompt += `

When suggesting changes to existing code, use SEARCH/REPLACE blocks instead of showing entire files:

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
- For new files, provide the full file content in a fenced code block with the filename (not a SEARCH/REPLACE block).
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

  if (scriptEnabled) {
    prompt += `

You have sandboxed code execution and file I/O tools:
- \`run_script\`: Execute code (python, javascript, typescript, bash, sh, ruby, perl). Use to run code, verify solutions, perform calculations, or demonstrate behavior.
- \`write_file\`: Write files to the persistent workspace. Use to create source files, configs, data, or multi-file projects.
- \`read_local_file\`: Read files from the workspace, including output files created by scripts.
- \`list_workspace\`: List files in the workspace directory.

The workspace is persistent within a session — files written with \`write_file\` are available to \`run_script\` and vice versa.
Use these tools proactively: write multi-file projects, run tests, verify your solutions work, and read output files to confirm results.`;
  }

  if (devToolsEnabled) {
    prompt += `

You have developer tools for terminal, git, and build operations:
- \`run_terminal\`: Execute any shell command in the workspace (npm install, ls, curl, etc.)
- \`git_command\`: Run git commands (status, diff, log, add, commit, branch, checkout, clone, push)
- \`build_project\`: Auto-detect project type and run build/test/lint/typecheck

Use these to:
- Clone repos and install dependencies
- Build projects and run tests to verify changes
- Use git to inspect history, create branches, and commit changes
- Push and pull from GitHub remotes (requires GITHUB_TOKEN to be configured)
- Run any CLI tool available in the environment`;
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
