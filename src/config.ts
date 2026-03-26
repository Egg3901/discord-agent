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

  // Anthropic
  ANTHROPIC_MODEL = optional('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514');

  // GitHub
  GITHUB_TOKEN: string | null = process.env['GITHUB_TOKEN'] || null;

  // Limits (mutable at runtime)
  MAX_SESSIONS_PER_USER = parseInt(optional('MAX_SESSIONS_PER_USER', '3'), 10);
  MAX_REQUESTS_PER_MINUTE = parseInt(optional('MAX_REQUESTS_PER_MINUTE', '10'), 10);
  MAX_CONTEXT_TOKENS = parseInt(optional('MAX_CONTEXT_TOKENS', '100000'), 10);

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
  };

  /**
   * Set a config value at runtime. Returns true if the key is valid and was set.
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
    } else {
      (this as any)[key] = value;
    }

    return { success: true };
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
