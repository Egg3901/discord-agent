import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

/**
 * Runtime-mutable configuration. Some fields can be changed via Discord commands.
 */
class Config {
  // Discord (immutable)
  readonly DISCORD_TOKEN = required('DISCORD_TOKEN');
  readonly DISCORD_CLIENT_ID = required('DISCORD_CLIENT_ID');
  readonly DISCORD_GUILD_ID = process.env['DISCORD_GUILD_ID'] || null;

  // Default model — uses Claude Code CLI (Max plan) by default.
  // Set ANTHROPIC_MODEL env var or use /config set ANTHROPIC_MODEL to override.
  ANTHROPIC_MODEL = optional('ANTHROPIC_MODEL', 'claude-code');

  // GitHub
  GITHUB_TOKEN: string | null = process.env['GITHUB_TOKEN'] || null;

  // Limits (mutable at runtime)
  MAX_SESSIONS_PER_USER = parseInt(optional('MAX_SESSIONS_PER_USER', '3'), 10);
  MAX_REQUESTS_PER_MINUTE = parseInt(optional('MAX_REQUESTS_PER_MINUTE', '10'), 10);
  MAX_CONTEXT_TOKENS = parseInt(optional('MAX_CONTEXT_TOKENS', '100000'), 10);

  // Agent mode
  ENABLE_EXTENDED_THINKING = process.env['ENABLE_EXTENDED_THINKING'] === 'true';
  THINKING_BUDGET_TOKENS = parseInt(optional('THINKING_BUDGET_TOKENS', '10000'), 10);
  MAX_AGENT_ITERATIONS = parseInt(optional('MAX_AGENT_ITERATIONS', '10'), 10);

  // Script execution
  ENABLE_SCRIPT_EXECUTION = process.env['ENABLE_SCRIPT_EXECUTION'] === 'true';
  SCRIPT_TIMEOUT_MS = parseInt(optional('SCRIPT_TIMEOUT_MS', '30000'), 10);

  // Dev tools (terminal, git, build)
  ENABLE_DEV_TOOLS = process.env['ENABLE_DEV_TOOLS'] === 'true';

  // Git author identity for bot commits (avoids Vercel ignoring bot-authored commits)
  GIT_AUTHOR_NAME: string | null = process.env['GIT_AUTHOR_NAME'] || null;
  GIT_AUTHOR_EMAIL: string | null = process.env['GIT_AUTHOR_EMAIL'] || null;

  // Claude Code provider timeout (ms). How long to wait for the CC CLI subprocess before killing it.
  CLAUDE_CODE_TIMEOUT_MS = parseInt(optional('CLAUDE_CODE_TIMEOUT_MS', '300000'), 10); // 5 min default

  // Claude Code provider: HOME directory override for finding CLI login credentials.
  // Set this to the home dir of the user who ran `claude login` (e.g. /home/myuser)
  // when the bot runs as a different user (e.g. systemd service).
  CLAUDE_CODE_HOME: string | null = process.env['CLAUDE_CODE_HOME'] || null;

  // Ollama (local or cloud-hosted models)
  OLLAMA_BASE_URL = optional('OLLAMA_BASE_URL', 'http://localhost:11434');
  // API key for cloud-hosted Ollama endpoints (sent as Bearer token). Leave empty for local.
  OLLAMA_API_KEY: string | null = process.env['OLLAMA_API_KEY'] || null;

  // Web search (Brave Search API)
  ENABLE_WEB_SEARCH = process.env['ENABLE_WEB_SEARCH'] === 'true';
  BRAVE_SEARCH_API_KEY: string | null = process.env['BRAVE_SEARCH_API_KEY'] || null;

  // Access control: managed via /admin allowrole and stored in database
  // Empty = everyone can use the bot

  // Storage (immutable)
  readonly DB_PATH = optional('DB_PATH', './data/bot.db');

  // Initial API keys (optional — can be added later via /admin addkey in Discord)
  readonly INITIAL_API_KEYS: string[] = (process.env['ANTHROPIC_API_KEYS'] || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  /**
   * Settable config keys and their types. Used by /config command.
   * Keys listed here can be changed at runtime by admins.
   * NOTE: Values are intentionally never exposed back to users.
   */
  static readonly SETTABLE_KEYS: Record<string, { type: 'string' | 'number'; description: string }> = {
    ANTHROPIC_MODEL: { type: 'string', description: 'Default Claude model for new sessions' },
    GITHUB_TOKEN: { type: 'string', description: 'GitHub personal access token for repo fetching' },
    MAX_SESSIONS_PER_USER: { type: 'number', description: 'Max concurrent sessions per user' },
    MAX_REQUESTS_PER_MINUTE: { type: 'number', description: 'Max requests per user per minute' },
    MAX_CONTEXT_TOKENS: { type: 'number', description: 'Max context window tokens' },
    ENABLE_EXTENDED_THINKING: { type: 'string', description: 'Enable extended thinking for complex tasks (true/false)' },
    THINKING_BUDGET_TOKENS: { type: 'number', description: 'Token budget for extended thinking' },
    MAX_AGENT_ITERATIONS: { type: 'number', description: 'Max tool-use iterations per agent loop' },
    ENABLE_SCRIPT_EXECUTION: { type: 'string', description: 'Enable sandboxed script execution tool (true/false)' },
    SCRIPT_TIMEOUT_MS: { type: 'number', description: 'Script execution timeout in milliseconds' },
    ENABLE_DEV_TOOLS: { type: 'string', description: 'Enable terminal, git, and build tools (true/false)' },
    CLAUDE_CODE_TIMEOUT_MS: { type: 'number', description: 'Timeout in ms for Claude Code CLI subprocess (default: 300000 = 5 min)' },
    CLAUDE_CODE_HOME: { type: 'string', description: 'HOME directory for Claude Code CLI login (e.g. /home/myuser)' },
    OLLAMA_BASE_URL: { type: 'string', description: 'Ollama server URL (default: http://localhost:11434)' },
    OLLAMA_API_KEY: { type: 'string', description: 'Bearer token for cloud-hosted Ollama endpoints (leave empty for local)' },
    ENABLE_WEB_SEARCH: { type: 'string', description: 'Enable web search and fetch tools (true/false)' },
    BRAVE_SEARCH_API_KEY: { type: 'string', description: 'Brave Search API key for web search tool' },
    GIT_AUTHOR_NAME: { type: 'string', description: 'Git author name for bot commits (avoids Vercel filtering bot commits)' },
    GIT_AUTHOR_EMAIL: { type: 'string', description: 'Git author email for bot commits (avoids Vercel filtering bot commits)' },
  };

  /**
   * Set a config value at runtime. Returns true if the key is valid and was set.
   * Persists the value to the database so it survives restarts.
   */
  set(key: string, value: string): { success: boolean; error?: string } {
    const meta = Config.SETTABLE_KEYS[key];
    if (!meta) {
      return { success: false, error: `Unknown or immutable config key: \`${key}\`. Settable keys: ${Object.keys(Config.SETTABLE_KEYS).map(k => `\`${k}\``).join(', ')}` };
    }

    if (meta.type === 'number') {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) {
        return { success: false, error: `\`${key}\` must be a positive number.` };
      }
      (this as any)[key] = num;
    } else if (key === 'ENABLE_EXTENDED_THINKING' || key === 'ENABLE_SCRIPT_EXECUTION' || key === 'ENABLE_DEV_TOOLS' || key === 'ENABLE_WEB_SEARCH') {
      if (value !== 'true' && value !== 'false') {
        return { success: false, error: `\`${key}\` must be 'true' or 'false'.` };
      }
      (this as any)[key] = value === 'true';
    } else {
      (this as any)[key] = value;
    }

    // Persist to database so the value survives restarts (lazy import to avoid circular dep)
    import('./storage/database.js')
      .then(({ saveConfigValue }) => saveConfigValue(key, value))
      .catch((err) => { /* Non-fatal but log it */
        // Can't import logger here due to circular deps — use console
        console.warn('Failed to persist config value:', key, err?.message || err);
      });

    return { success: true };
  }

  /**
   * Restore persisted config values from the database.
   * Database values override .env defaults but not explicit env vars.
   * Accepts stored values as a parameter to avoid circular dependency with database.ts.
   */
  restoreFromDb(stored: Record<string, string>): void {
    for (const [key, value] of Object.entries(stored)) {
      // Skip if the env var is explicitly set (env takes precedence)
      if (process.env[key]) continue;
      const meta = Config.SETTABLE_KEYS[key];
      if (!meta) continue;

      if (meta.type === 'number') {
        const num = parseInt(value, 10);
        if (!isNaN(num) && num > 0) (this as any)[key] = num;
      } else if (key === 'ENABLE_EXTENDED_THINKING' || key === 'ENABLE_SCRIPT_EXECUTION' || key === 'ENABLE_DEV_TOOLS' || key === 'ENABLE_WEB_SEARCH') {
        (this as any)[key] = value === 'true';
      } else {
        (this as any)[key] = value;
      }
    }
  }

  /**
   * List settable keys with descriptions (but NEVER their current values).
   */
  listSettableKeys(): { key: string; type: string; description: string }[] {
    return Object.entries(Config.SETTABLE_KEYS).map(([key, meta]) => ({
      key,
      type: meta.type,
      description: meta.description,
    }));
  }
}

export const config = new Config();
