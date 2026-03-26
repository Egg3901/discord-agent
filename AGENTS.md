# Discord Agent - Agent Instructions

Instructions for AI coding agents (Claude Code, Codex, Copilot, Cursor, Windsurf, etc.) working on this codebase.

## Project Overview

Discord bot providing AI-powered coding assistance through Discord. Users interact via slash commands (`/code`, `/ask`) and threaded conversations. Supports multi-provider AI (Anthropic Claude + Google Gemini), API key pooling with health tracking, persistent sessions, GitHub repo context, and streaming responses.

**Stack**: TypeScript, Node.js, Discord.js, better-sqlite3, Anthropic SDK, Google GenAI SDK, Octokit

## Architecture

```
src/
  index.ts      - Entry point, service initialization
  config.ts     - Runtime-mutable config (env + admin-set values)
  bot/          - Discord.js client, slash commands, event handlers, middleware
    commands/   - Slash command handlers (ask, code, session, repo, admin, config, model, help)
    events/     - ready, interactionCreate, messageCreate (thread message handling)
    middleware/ - permissions (role-based ACL), rateLimiter (per-user)
  claude/       - AI client (multi-provider), context builder, response streaming
  keys/         - API key pool: weighted round-robin, health tracking, SQLite persistence
  sessions/     - Thread-based session lifecycle, auto-expiry, message history
  github/       - Octokit-based repo file fetching
  storage/      - SQLite schema + migrations (api_keys, sessions, usage_log, allowed_roles)
  utils/        - Logger (pino), error types, Discord message chunking
```

## Key Design Decisions

- **Multi-provider routing**: Model name prefix determines provider (`claude-*` -> Anthropic, `gemini-*` -> Google). See `src/claude/aiClient.ts:getProviderForModel`.
- **Key pooling**: Weighted selection favoring healthiest key with fewest requests. Keys auto-degrade (healthy -> degraded -> dead) and resurrect on retry. See `src/keys/keyPool.ts`.
- **Session persistence**: Sessions serialize to SQLite including full message history. Auto-prune at 30 min inactivity. See `src/sessions/sessionManager.ts`.
- **Streaming chunking**: Responses stream token-by-token, flushed to Discord every 3-5s, auto-split at 2000 chars respecting code block boundaries. See `src/claude/responseFormatter.ts`.
- **Runtime config**: Admins change model, token limits, rate limits at runtime via `/config set` without restart.

## Development Commands

```sh
npm run dev          # Development with hot reload (tsx --watch)
npm run build        # Compile TypeScript — use this to check for type errors
npm start            # Run production build
npm run register-commands  # Register Discord slash commands with Discord API
```

## Environment Setup

Copy `.env.example` to `.env`. Required: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`. API keys are added at runtime via `/admin addkey`. Optional: `DISCORD_GUILD_ID` (dev command scoping), `GITHUB_TOKEN` (private repos).

## Code Conventions

- TypeScript strict mode, ES2022 target, ESM modules
- Imports **must** use `.js` extensions (ESM requirement)
- Logging via pino (`src/utils/logger.ts`) — use structured logging: `logger.info({ key: value }, 'message')`
- Custom error types in `src/utils/errors.ts`
- Database: better-sqlite3 with synchronous API, no async/await needed for DB calls
- All Discord interactions must `deferReply()` before async work
- No test suite exists yet — validate changes with `npm run build`

## Common Change Patterns

| Task | What to do |
|------|-----------|
| New slash command | Add handler in `src/bot/commands/`, register in `src/bot/commands/registry.ts`, run `npm run register-commands` |
| New AI provider | Add prefix routing in `aiClient.ts:getProviderForModel`, implement `stream<Provider>` method in `AIClient` class |
| Database schema change | Add migration in `src/storage/database.ts:initializeDatabase` |
| New middleware | Add in `src/bot/middleware/`, apply in event handlers |
| Config change | Add to `src/config.ts` config object and `MUTABLE_KEYS` if runtime-mutable |

## Gotchas

- Discord messages have a 2000 character limit. All AI responses go through `src/claude/responseFormatter.ts` which handles chunking. Don't bypass this.
- Slash command metadata changes require re-registration with Discord (`npm run register-commands`). Just deploying code isn't enough.
- The key pool queue has a 60-second timeout. If all keys are busy, requests fail with a queue timeout — this is intentional, not a bug.
- `nanoid` v5 is ESM-only. Don't try to use `require()` anywhere.
- SQLite is single-writer. The bot runs single-process, so this is fine. Don't add clustering without addressing this.

## Parity Gaps vs Claude Code / Codex

The following capabilities exist in agentic coding tools (Claude Code, Codex, etc.) but are missing or limited here. This is the roadmap for feature parity:

### High Priority

1. **Tool Use / Agentic Mode** — Agentic tools can read files, edit files, run commands, and search code. This bot is chat-only with no tool execution. Adding tool_use with sandboxed execution would be the single biggest capability leap. Design: define tools (read_file, edit_file, run_command, search), execute in a sandbox, return results in the conversation loop.

2. **Extended Thinking** — Agentic tools use chain-of-thought reasoning for complex problems. The bot should pass thinking/reasoning parameters for models that support it (Anthropic extended thinking, Gemini thinking mode) to improve code quality on hard problems.

3. **Structured Diffs** — Agentic tools show precise file edits (search/replace, unified diff). The bot returns full code blocks. Adding diff-aware output formatting would significantly improve usability for code modification tasks.

4. **Multi-step Agent Loops** — Agentic tools run iterative loops (read -> think -> edit -> verify). The bot does single-turn responses. Supporting agent loops with intermediate status updates in Discord threads would enable complex multi-file tasks.

### Medium Priority

5. **MCP Server Integration** — Connect to Model Context Protocol servers to give the AI structured tool access (GitHub, filesystem, databases) without building custom integrations for each.

6. **Image/Multimodal Input** — Both Claude and Gemini support image inputs. The bot should extract images from Discord attachments and pass them as image content blocks.

7. **Codebase Indexing** — Instead of fetching full repo files via `/repo`, build a searchable index so the AI can request relevant files on demand rather than stuffing everything in context upfront.

8. **Code Execution Sandbox** — Run code snippets in a sandboxed environment (Docker, Firecracker, or WASM) and return output. Critical for verifying generated code.

9. **Thinking Budget Controls** — Expose `max_tokens`, thinking budget, and temperature as session-level settings so users can control the cost vs quality tradeoff per task.

### Lower Priority

10. **Prompt Caching** — Use provider-specific caching (Anthropic prompt caching, Gemini context caching) for system prompts and repo context to reduce latency and cost on multi-turn sessions.

11. **File Output as Attachments** — Return generated files as Discord file attachments rather than inline code blocks when output exceeds a reasonable size.

12. **Conversation Branching** — Allow users to fork a conversation from a specific point to explore alternate approaches without losing the original thread.

13. **Structured Progress** — Show what the agent is doing (tools called, files read, commands run) as structured updates rather than just streaming text.

14. **Cost Tracking** — Track and display token usage and estimated cost per session and per user. The `usage_log` table already exists — surface it.
