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

## Script Capabilities

The bot is an AI coding assistant — it does **not** execute code or interact with file systems directly. It cannot run scripts, access databases, or modify files on a server.

### What It Can Do

| Capability | Description |
|------------|-------------|
| **Write scripts** | Generate complete, ready-to-run code in any language |
| **Debug existing scripts** | Analyze code you share and help fix issues |
| **Explain how to run scripts** | Provide step-by-step execution instructions for your environment |
| **Optimize & review** | Improve performance, readability, and correctness of code you share |
| **Explore GitHub repos** | When a repo is attached via `/repo`, the bot can read files, list directories, and search code using GitHub API tools |

### What It Cannot Do

- Execute or run code snippets
- Access local file systems or databases
- Install packages or dependencies
- Make HTTP requests to external services
- Modify files outside of Discord messages

When users ask the bot to run a script, it will provide the code along with instructions for executing it in their own environment.

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
│   ├── anthropicClient.ts   # Anthropic SDK wrapper with streaming
│   ├── contextBuilder.ts    # System prompt + context management
│   └── responseFormatter.ts # Discord message chunking
├── keys/
│   ├── keyPool.ts           # API key rotation and health tracking
│   └── types.ts             # Key-related types
├── sessions/
│   ├── session.ts           # Session type definition
│   └── sessionManager.ts    # Session lifecycle management
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
