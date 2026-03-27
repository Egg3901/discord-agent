# Discord Agent

A Discord bot that provides Claude Code/Codex-like coding assistance via Discord, with support for multiple API key pooling and load balancing.

## Features

- **Multi-API Key Pooling**: Rotate across multiple Anthropic API keys with health tracking, automatic failover, and load balancing
- **Coding Sessions**: Start threaded coding sessions with `/code` — Claude maintains conversation context across the thread
- **One-shot Questions**: Quick answers with `/ask` without creating a session
- **GitHub Repo Context**: Attach a GitHub repository to your session with `/repo` for context-aware assistance
- **Streaming Responses**: Responses stream in real-time, automatically chunked for Discord's 2000-character limit
- **Rate Limiting**: Per-user rate limiting to prevent abuse
- **Admin Controls**: Manage API keys, view stats, and prune sessions via `/admin`
- **Session Management**: View and end your sessions with `/session`

## Setup

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application and add a bot
3. Enable the **Message Content** intent under Bot settings
4. Generate an invite URL with `bot` and `applications.commands` scopes
5. Invite the bot to your server

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-client-id
DISCORD_GUILD_ID=your-guild-id          # Optional, for faster dev command registration
ANTHROPIC_API_KEYS=sk-ant-key1,sk-ant-key2  # Comma-separated
ADMIN_USER_IDS=your-discord-user-id
GITHUB_TOKEN=ghp_xxx                    # Optional, for private repos
```

### 3. Install and Run

```bash
npm install
npm run dev     # Development with hot reload
npm run build   # Compile TypeScript
npm start       # Production
```

## Commands

| Command | Description |
|---------|-------------|
| `/ask <question>` | Ask Claude a one-shot question |
| `/code <prompt>` | Start a threaded coding session |
| `/repo <url> [paths]` | Attach GitHub repo context to current session |
| `/session end` | End the current session |
| `/session status` | View your active sessions |
| `/admin addkey <key>` | Add an API key to the pool |
| `/admin removekey <id>` | Remove an API key |
| `/admin keys` | List all keys and their health status |
| `/admin stats` | View bot statistics |
| `/admin prune` | Force-prune stale sessions |

## Script Execution & Sandbox

When enabled, the bot can execute code and manage files in a sandboxed workspace — directly from Discord.

**Tools available to the AI:**

| Tool | Description |
|------|-------------|
| `run_script` | Execute code (Python, JS, TS, Bash, Ruby, Perl) |
| `write_file` | Create/write files in the workspace |
| `read_local_file` | Read files from the workspace |
| `list_workspace` | List workspace contents |

**How it works:**
- Each session gets an isolated workspace in `/tmp`
- Files written with `write_file` persist and are available to `run_script`
- The AI can build multi-file projects, run tests, and verify its own solutions
- Workspaces are automatically cleaned up when sessions end

**Safety:**
- Isolated per-session directories with path traversal protection
- Configurable timeout (default: 30 seconds)
- Output truncated at 10KB, files capped at 100KB
- Disabled by default — enable with `/config set ENABLE_SCRIPT_EXECUTION true`

**Configuration:**
| Key | Default | Description |
|-----|---------|-------------|
| `ENABLE_SCRIPT_EXECUTION` | `false` | Enable sandbox tools |
| `SCRIPT_TIMEOUT_MS` | `30000` | Max execution time per script (ms) |

## Architecture

```
src/
├── index.ts                 # Entry point
├── config.ts                # Environment configuration
├── bot/
│   ├── client.ts            # Discord client setup
│   ├── commands/             # Slash command handlers
│   ├── events/               # Discord event handlers
│   └── middleware/            # Rate limiting, permissions
├── claude/
│   ├── aiClient.ts          # Multi-provider AI client (Claude + Gemini)
│   ├── agentLoop.ts         # Multi-step tool-use orchestration
│   ├── contextBuilder.ts    # System prompt + context management
│   └── responseFormatter.ts # Discord message chunking
├── keys/
│   ├── keyPool.ts           # API key rotation and health tracking
│   └── types.ts             # Key-related types
├── sessions/
│   ├── session.ts           # Session type definition
│   └── sessionManager.ts    # Session lifecycle management
├── tools/
│   ├── toolDefinitions.ts   # Agent tool schemas (repo + sandbox tools)
│   ├── toolExecutor.ts      # Tool dispatch and execution
│   └── scriptExecutor.ts    # Sandboxed script runner + file I/O
├── github/
│   └── repoFetcher.ts       # GitHub API file fetching
├── storage/
│   └── database.ts          # SQLite persistence
└── utils/
    ├── logger.ts            # Structured logging (pino)
    ├── errors.ts            # Custom error types
    └── chunks.ts            # Message splitting utilities
```

### Key Pool

The key pool implements weighted round-robin selection:
- Picks the healthy key with the fewest requests in the current minute
- Automatically marks keys as degraded/dead after consecutive failures
- Resurrects dead keys periodically for retry
- Queues requests when all keys are busy (60s timeout)

### Sessions

- Each `/code` command creates a Discord thread and an associated session
- Follow-up messages in the thread are automatically handled
- Sessions auto-expire after 30 minutes of inactivity
- Per-user session limit (default: 3 concurrent)

## License

MIT
