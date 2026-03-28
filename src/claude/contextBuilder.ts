import type { ContentBlock } from './aiClient.js';

export interface RepoContext {
  repoUrl: string;
  files: { path: string; content: string }[];
}

export function buildSystemPrompt(repoContext?: RepoContext, toolsEnabled?: boolean, scriptEnabled?: boolean, devToolsEnabled?: boolean, webSearchEnabled?: boolean): string {
  let prompt = `You are a software engineering assistant on Discord. Write, edit, review, debug, and explain code in any language.

**How responses are displayed — understand this before responding:**
The bot streams your response into a single Discord message that is edited in place. Tool calls are automatically shown as separate blockquote messages (e.g. \`> 📄 Reading \`src/index.ts\`\`) — you do not need to announce or narrate them. The user sees tool activity as it happens; your text is the final answer after tools finish.

**Response rules:**
- Call tools first. Do not write anything before tool calls — the bot shows tool progress automatically.
- After tools finish, write one concise response. Do not summarize what the tools found step-by-step.
- No preamble. No "I'll now...", "Let me...", "Sure!". Lead with the answer or code.
- No walls of text. If your answer would be long, cut what isn't essential. The user can ask for more.
- No spamming. One message, not five. Don't split thoughts across multiple short messages.
- Use Discord markdown: \`\`\`lang for code blocks, **bold** for key terms, \`inline code\` for identifiers.
- When showing code changes, use SEARCH/REPLACE blocks (see below), not full file dumps.
- Only elaborate when asked or when the situation is genuinely complex.`;

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
  prompt += `

**You have tools. Always attempt tasks using your tools before concluding something can't be done. Never tell the user to do something themselves if a tool could do it. If a tool call fails, retry with a corrected input or try an alternative tool — do not give up and redirect the user.**

**Available tools — use ONLY the tools listed below. Do not call any tool not listed here.**`;

  if (toolsEnabled) {
    prompt += `

**Repo tools** (operate on the attached GitHub repository):
- \`read_file(path)\`: Read a file by path relative to the repo root. Returns full content truncated at 50 KB. Returns an error if the path does not exist.
- \`read_files_batch(paths)\`: Read multiple files in one call. Pass a comma-separated list of paths (e.g. \`"src/index.ts,src/config.ts"\`). More efficient than multiple \`read_file\` calls.
- \`list_directory(path)\`: List files and subdirectories at a repo path. Use \`""\` for the root. Returns names with file/directory type indicators.
- \`search_code(query)\`: Search for a plain-text string across all repo files. Returns up to 10 matching file paths with line snippets.
- \`search_files(pattern)\`: Find files by name or glob pattern (e.g. \`"*.ts"\`, \`"src/**/*.json"\`, \`"*config*"\`). Returns matching paths. Use this instead of recursive \`list_directory\` when you know the filename pattern.

Rules for repo tools:
- Use \`search_files\` to find a file by name pattern instead of recursive \`list_directory\` calls.
- Use \`read_files_batch\` when you need to read 2+ files — it saves iterations.
- Always read a file before referencing its contents or writing SEARCH blocks against it.
- Use \`search_code\` to find where a symbol or pattern is defined, then \`read_file\` to read context.
- These tools only work when a repo is attached. If no repo is attached, these tools will fail.`;
  }

  if (scriptEnabled) {
    prompt += `

**Sandbox tools** (persistent file workspace per session):
- \`run_script(language, code)\`: Execute a script and return stdout/stderr. Supported languages: \`python\`, \`javascript\`, \`typescript\`, \`bash\`, \`sh\`, \`ruby\`, \`perl\`. Files written with \`write_file\` are available to scripts.
- \`write_file(path, content)\`: Write a file to the sandbox workspace. Subdirectories are created automatically. Files persist across all tool calls in the session.
- \`read_local_file(path)\`: Read a file from the sandbox workspace. Use to verify written files or read script output.
- \`list_workspace(path)\`: List files in the sandbox workspace. Use \`""\` for the root.

Rules for sandbox tools:
- Always run scripts to verify your solutions, not just to demonstrate them.
- For multi-file projects: use \`write_file\` for each file, then \`run_script\` to build/test.
- Check \`list_workspace\` if you're unsure what files exist before reading.`;
  }

  if (devToolsEnabled) {
    prompt += `

**Dev tools** (shell, git, and build operations in the workspace):
- \`run_terminal(command)\`: Execute a shell command. Returns stdout, stderr, and exit code. Timeout: 60 seconds. Use for \`npm install\`, file operations, \`curl\`, compilers, etc.
- \`git_command(args)\`: Run a git subcommand. Pass only the arguments after \`git\` (e.g. \`"status"\`, \`"log --oneline -10"\`, \`"commit -m \\"message\\""\`). The workspace must already be a git repo, or use \`git_command("clone <url> .")\` first.
- \`build_project(action?)\`: Auto-detect project type (package.json, Makefile, Cargo.toml, pyproject.toml, etc.) and run the requested action. \`action\` is optional and defaults to \`"build"\`. Valid values: \`"build"\`, \`"test"\`, \`"lint"\`, \`"typecheck"\`, or any custom command string.

Rules for dev tools:
- Prefer \`build_project\` over \`run_terminal\` for standard build/test/lint operations — it handles project detection automatically.
- Use \`run_terminal\` for one-off commands, dependency installation, or anything not covered by \`build_project\`.
- Pushing to GitHub remotes via \`git_command\` requires GITHUB_TOKEN to be configured by the user.`;
  }

  if (webSearchEnabled) {
    prompt += `

**Web tools** (live internet access):
- \`web_search(query)\`: Search the web via Brave Search. Returns titles, URLs, and descriptions. Use for current docs, release notes, CVEs, or anything that may have changed since your training cutoff.
- \`web_fetch(url)\`: Fetch the full text of a web page (HTML stripped, truncated at 50 KB). Use after \`web_search\` to read a specific result. URL must start with \`http://\` or \`https://\`.

Rules for web tools:
- Use \`web_search\` before answering questions about library versions, recent events, or APIs that may have changed.
- Always follow up with \`web_fetch\` on the most relevant result before quoting specific content — summaries from search results can be misleading.`;
  }

  // Inform the model about disabled features so it can guide users to enable them
  const disabledFeatures: string[] = [];
  if (!scriptEnabled) disabledFeatures.push('**Script execution** is disabled. If the user asks you to run code or execute a script, tell them: "Script execution is disabled. An admin can enable it with `/config set ENABLE_SCRIPT_EXECUTION true`."');
  if (!devToolsEnabled) disabledFeatures.push('**Dev tools** (terminal, git, build) are disabled. If the user asks you to run shell commands, clone a repo, or build a project, tell them: "Dev tools are disabled. An admin can enable them with `/config set ENABLE_DEV_TOOLS true`."');
  if (!webSearchEnabled) disabledFeatures.push('**Web search** is disabled. If the user asks you to look up current docs, changelogs, or live information, tell them: "Web search is disabled. An admin can enable it with `/config set ENABLE_WEB_SEARCH true`."');

  if (disabledFeatures.length > 0) {
    prompt += `

**Features not available in this session:**
${disabledFeatures.map((f) => `- ${f}`).join('\n')}`;
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
    // Drop leading assistant messages from tail so we can insert an assistant bridge
    // without creating consecutive same-role pairs after the first (user) message.
    while (tail.length > 0 && tail[0].role !== 'user') {
      tail.shift();
    }
    result.push({
      role: 'assistant' as const,
      content: '[Note: earlier messages trimmed to fit context window]',
    });
  }

  result.push(...tail);
  return result;
}
