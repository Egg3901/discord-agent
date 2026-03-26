import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  // Discord
  DISCORD_TOKEN: required('DISCORD_TOKEN'),
  DISCORD_CLIENT_ID: required('DISCORD_CLIENT_ID'),
  DISCORD_GUILD_ID: process.env['DISCORD_GUILD_ID'] || null,

  // Anthropic
  ANTHROPIC_API_KEYS: required('ANTHROPIC_API_KEYS')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean),
  ANTHROPIC_MODEL: optional('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),

  // GitHub
  GITHUB_TOKEN: process.env['GITHUB_TOKEN'] || null,

  // Admin
  ADMIN_USER_IDS: (process.env['ADMIN_USER_IDS'] || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),

  // Limits
  MAX_SESSIONS_PER_USER: parseInt(optional('MAX_SESSIONS_PER_USER', '3'), 10),
  MAX_REQUESTS_PER_MINUTE: parseInt(optional('MAX_REQUESTS_PER_MINUTE', '10'), 10),
  MAX_CONTEXT_TOKENS: parseInt(optional('MAX_CONTEXT_TOKENS', '100000'), 10),

  // Storage
  DB_PATH: optional('DB_PATH', './data/bot.db'),
} as const;
