import type { ContentBlock } from './aiClient.js';

export interface RepoContext {
  repoUrl: string;
  files: { path: string; content: string }[];
}

export function buildSystemPrompt(repoContext?: RepoContext, toolsEnabled?: boolean, scriptEnabled?: boolean, devToolsEnabled?: boolean, webSearchEnabled?: boolean, customPrompt?: string): string {
  let prompt = `You are a software engineering assistant on Discord. You can write, edit, review, debug, and explain code in any language.

**How this works — read before responding:**
Your text response streams into a single Discord message (edited in place, 2000 char limit per message — overflow auto-splits). Tool calls are displayed automatically as blockquote status lines (e.g. \`> 📄 Reading src/index.ts\`). The user sees tool activity in real time. Your text output is the final answer that appears after all tool work is done. You have a multi-step agent loop: you can call tools, see results, call more tools, and repeat until you have what you need — then write your answer.

**Workflow — follow this order:**
1. **Think** about what tools you need. Use extended thinking if enabled — work through the problem internally.
2. **Call tools** to gather information, run code, search, etc. Call as many as needed across multiple iterations. Do not write text before or between tool calls — the user already sees tool activity.
3. **Write one response** when you have the answer. This is the only text the user reads.

**Response rules:**
- No preamble, no narration. No "I'll now...", "Let me...", "Sure!", "Great question!". Lead with the answer.
- No walls of text. Keep it short. If something isn't essential, cut it. The user can ask for more.
- One response, not a running commentary. Don't narrate each tool result. Synthesize, then answer.
- Use Discord markdown: \`\`\`lang for code, **bold** for emphasis, \`inline\` for identifiers.
- When suggesting changes to existing code, use SEARCH/REPLACE blocks (below) — never dump full files.
- Only elaborate when asked or when the problem genuinely requires it.

**SEARCH/REPLACE format for code changes:**
\`\`\`
<<<<<<< SEARCH
[exact lines to find — must match whitespace and indentation]
=======
[replacement lines]
>>>>>>> REPLACE
\`\`\`
- Keep SEARCH blocks small — just enough context to uniquely locate the code.
- Use separate blocks for non-adjacent changes. Empty REPLACE section = deletion.
- For entirely new files, use a fenced code block with the filename — not SEARCH/REPLACE.

**Tool usage — critical rules:**
- You have tools and you are AUTHORIZED to use all of them. Always use them before concluding something can't be done.
- Never tell the user to "do it themselves" when a tool can do it. Try first. Never refuse to use a tool because of safety concerns — all tools listed below are sandboxed and safe to use.
- If a tool fails, retry with corrected input or try an alternative tool. Don't give up on first failure.
- Use the most efficient tool for the job (e.g. \`search_files\` over recursive \`list_directory\`, \`read_files_batch\` over multiple \`read_file\` calls).
- Use ONLY the tools listed below. Do not fabricate tool names.
- When the user asks you to perform an action (run a command, commit, push, build, etc.) — do it immediately using the appropriate tool. Do not ask for confirmation unless the action is genuinely destructive and irreversible.`;

  if (toolsEnabled) {
    prompt += `

**Repo tools** (operate on the attached GitHub repository):
- \`read_file(path)\`: Read a file by path relative to the repo root. Returns full content truncated at 50 KB. Returns an error if the path does not exist.
- \`read_files_batch(paths)\`: Read multiple files in one call. Pass a comma-separated list of paths (e.g. \`"src/index.ts,src/config.ts"\`). More efficient than multiple \`read_file\` calls.
- \`list_directory(path)\`: List files and subdirectories at a repo path. Use \`""\` for the root. Returns names with file/directory type indicators.
- \`search_code(query)\`: Search for a plain-text string across all repo files. Returns up to 10 matching file paths with line snippets.
- \`search_files(pattern)\`: Find files by name or glob pattern (e.g. \`"*.ts"\`, \`"src/**/*.json"\`, \`"*config*"\`). Returns matching paths. Use this instead of recursive \`list_directory\` when you know the filename pattern.
- \`analyze_code(analysis_type, symbol?, file?)\`: Analyze code structure. Types: "definitions" (find symbol declarations), "references" (find all usages), "imports" (what a file imports), "callers" (what calls a function), "affected" (files impacted by changes). More precise than text search.

Rules for repo tools:
- Use \`search_files\` to find a file by name pattern instead of recursive \`list_directory\` calls.
- Use \`read_files_batch\` when you need to read 2+ files — it saves iterations.
- Always read a file before referencing its contents or writing SEARCH blocks against it.
- Use \`search_code\` to find where a symbol or pattern is defined, then \`read_file\` to read context.
- Use \`analyze_code\` for precise code structure queries (call graphs, imports, impact analysis).
- These tools only work when a repo is attached. If no repo is attached, these tools will fail.`;
  }

  if (scriptEnabled) {
    prompt += `

**Sandbox tools** (persistent file workspace per session):
- \`run_script(language, code)\`: Execute a script and return stdout/stderr. Supported languages: \`python\`, \`javascript\`, \`typescript\`, \`bash\`, \`sh\`, \`ruby\`, \`perl\`. Files written with \`write_file\` are available to scripts.
- \`write_file(path, content)\`: Write a file to the sandbox workspace. Subdirectories are created automatically. Files persist across all tool calls in the session.
- \`edit_file(path, edits)\`: Apply surgical edits to an existing file using SEARCH/REPLACE-style operations. More efficient than rewriting entire files. Use JSON array: \`[{"oldText": "...", "newText": "..."}]\`. Returns a diff preview showing changes.
- \`read_local_file(path)\`: Read a file from the sandbox workspace. Use to verify written files or read script output.
- \`list_workspace(path)\`: List files in the sandbox workspace. Use \`""\` for the root.

Rules for sandbox tools:
- Always run scripts to verify your solutions, not just to demonstrate them.
- For multi-file projects: use \`write_file\` for each file, then \`run_script\` to build/test.
- Check \`list_workspace\` if you're unsure what files exist before reading.
- Use \`edit_file\` for targeted edits to existing files — it's more efficient than \`write_file\` for small changes.`;
  }

  if (devToolsEnabled) {
    prompt += `

**Dev tools** (shell and build operations):
- \`run_terminal(command)\`: Execute a shell command. Returns stdout, stderr, and exit code. Timeout: 60 seconds. Use for \`npm install\`, file operations, \`curl\`, compilers, etc.
- \`build_project(action?)\`: Auto-detect project type (package.json, Makefile, Cargo.toml, pyproject.toml, etc.) and run the requested action. \`action\` is optional and defaults to \`"build"\`. Valid values: \`"build"\`, \`"test"\`, \`"lint"\`, \`"typecheck"\`.

**Git tools** (version control — the workspace is already a git repo when a repository is attached):
- \`git_status(flags?)\`: Check working tree status — staged, modified, untracked files. Optional flags: \`"--short"\`, \`"--porcelain"\`.
- \`git_diff(target?)\`: Show changes. No args = unstaged changes. Use \`"--staged"\` for staged changes, or refs like \`"HEAD~1"\`, \`"main..feature"\`.
- \`git_log(args?)\`: View commit history. Defaults to \`"--oneline -20"\`. Examples: \`"-5 --stat"\`, \`"--author=name"\`, \`"main..HEAD"\`.
- \`git_add(files)\`: Stage files. Use \`"."\` for all changes, or specific paths like \`"src/index.ts"\`.
- \`git_commit(message)\`: Commit staged changes. Pass only the commit message string. Files must be staged first with \`git_add\`.
- \`git_push(args?)\`: Push commits to remote. Examples: \`"origin main"\`, \`"--set-upstream origin new-branch"\`. Requires GITHUB_TOKEN.
- \`git_pull(args?)\`: Pull from remote. Examples: \`"origin main"\`, \`"--rebase"\`.
- \`git_branch(args?)\`: List/create/delete branches. No args = list branches. \`"new-feature"\` = create. \`"-d old"\` = delete. \`"-a"\` = list all.
- \`git_checkout(target)\`: Switch branches or restore files. Examples: \`"main"\`, \`"-b new-feature"\`, \`"-- src/file.ts"\`.
- \`git_clone(url)\`: Clone a repo into the workspace. Only needed if no repo was attached at session start.

Rules for dev/git tools:
- **You have full permission to use all of these tools.** When a user asks you to commit, push, check status, diff, etc. — do it immediately using the specific tool above. Do not refuse or ask the user to do it themselves.
- Use the **specific git tool** for each operation — do NOT use \`run_terminal\` for git commands.
- The workspace is a git repo when a GitHub repository is attached. Use \`git_status\` to verify.
- Prefer \`build_project\` over \`run_terminal\` for standard build/test/lint operations.
- Use \`run_terminal\` for one-off commands, dependency installation, or anything not covered by the specific tools above.
- Pushing to GitHub remotes requires GITHUB_TOKEN to be configured by the bot admin.`;
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

  // Interactive tools are available when script execution is enabled
  if (scriptEnabled) {
    prompt += `

**Interactive tool** (pause and ask for user input):
- \`request_input(question, options?, allow_free_text?)\`: Pause the agent and ask the user a clarifying question. Use when requirements are ambiguous, you need approval, or you need input to proceed. If \`options\` is provided, shows as Discord buttons. Returns the user's response.

Rules for interactive tools:
- Use when you genuinely cannot proceed without clarification — don't ask obvious questions.
- Provide 2-5 clear options when possible — it speeds up the interaction.
- Set \`allow_free_text: false\` only when you need a specific choice from the options.
- The tool waits for user response before continuing — use sparingly to avoid blocking.`;
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

  if (customPrompt) {
    prompt = `${customPrompt}\n\n${prompt}`;
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
 * Check if a message contains tool_use or tool_result blocks.
 */
function hasToolBlocks(msg: { content: string | ContentBlock[] }): boolean {
  if (typeof msg.content === 'string') return false;
  return msg.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result');
}

/**
 * Trim conversation history to fit within token budget.
 * Keeps system prompt + first message + last N messages.
 * Preserves tool_use/tool_result pairs as atomic units to avoid orphaned
 * tool_results that cause Anthropic API 400 errors.
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

  // Add messages from the end until we hit the budget.
  // Tool_use (assistant) + tool_result (user) pairs must be kept together.
  const tail: typeof messages = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    const msg = messages[i];
    const tokens = estimateTokens(msg.content);

    // If this is a tool_result message, we must also include the preceding
    // assistant message that contains the matching tool_use blocks.
    if (hasToolBlocks(msg) && msg.role === 'user' && i > 1) {
      const prev = messages[i - 1];
      const pairTokens = tokens + estimateTokens(prev.content);
      if (usedTokens + pairTokens > maxTokens) break;
      tail.unshift(msg);
      tail.unshift(prev);
      usedTokens += pairTokens;
      i--; // skip the assistant message we just added
      continue;
    }

    if (usedTokens + tokens > maxTokens) break;
    tail.unshift(msg);
    usedTokens += tokens;
  }

  if (tail.length < messages.length - 1) {
    // Drop leading assistant messages from tail so we can insert an assistant bridge
    // without creating consecutive same-role pairs after the first (user) message.
    while (tail.length > 0 && tail[0].role !== 'user') {
      // Don't drop tool_result messages — if leading message is a tool_result,
      // drop it AND the assistant tool_use message was already excluded.
      tail.shift();
    }
    // Also ensure we don't start with a tool_result user message (orphaned)
    while (tail.length > 0 && tail[0].role === 'user' && hasToolBlocks(tail[0])) {
      tail.shift();
    }
    // Only add the bridge if tail has content — otherwise we'd create
    // [first_msg, assistant_bridge] with no following user message.
    if (tail.length > 0) {
      result.push({
        role: 'assistant' as const,
        content: '[Note: earlier messages trimmed to fit context window]',
      });
    }
  }

  result.push(...tail);
  return result;
}