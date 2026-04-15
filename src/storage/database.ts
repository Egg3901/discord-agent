import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    // Auto-create the data directory if it doesn't exist
    mkdirSync(dirname(config.DB_PATH), { recursive: true });
    db = new Database(config.DB_PATH);
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    logger.info({ path: config.DB_PATH }, 'Database initialized');
  }
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'anthropic',
      added_at INTEGER NOT NULL,
      added_by TEXT NOT NULL DEFAULT 'system',
      total_requests INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      channel_id TEXT NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]',
      repo_context TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      session_id TEXT,
      key_id TEXT NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      model TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS allowed_roles (
      role_id TEXT PRIMARY KEY,
      role_name TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_thread_id ON sessions(thread_id);
    CREATE INDEX IF NOT EXISTS idx_usage_log_user_id ON usage_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_log_timestamp ON usage_log(timestamp);
  `);

  // Migration: add cost_usd column if missing
  const cols = db.prepare("PRAGMA table_info(usage_log)").all() as any[];
  if (!cols.some((c: any) => c.name === 'cost_usd')) {
    db.exec('ALTER TABLE usage_log ADD COLUMN cost_usd REAL');
  }

  // Migration: add model_override column to sessions if missing
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as any[];
  if (!sessionCols.some((c: any) => c.name === 'model_override')) {
    db.exec('ALTER TABLE sessions ADD COLUMN model_override TEXT');
  }

  // Migration: add thinking columns to sessions if missing
  if (!sessionCols.some((c: any) => c.name === 'thinking_enabled')) {
    db.exec('ALTER TABLE sessions ADD COLUMN thinking_enabled INTEGER');
  }
  if (!sessionCols.some((c: any) => c.name === 'thinking_budget')) {
    db.exec('ALTER TABLE sessions ADD COLUMN thinking_budget INTEGER');
  }

  // Migration: add system_prompt column to sessions if missing
  if (!sessionCols.some((c: any) => c.name === 'system_prompt')) {
    db.exec('ALTER TABLE sessions ADD COLUMN system_prompt TEXT');
  }

  // Migration: add secondary_repo_context column to sessions if missing
  if (!sessionCols.some((c: any) => c.name === 'secondary_repo_context')) {
    db.exec('ALTER TABLE sessions ADD COLUMN secondary_repo_context TEXT');
  }

  // Migration: claude_code_sessions table for cross-restart CC session continuity
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_code_sessions (
      session_key TEXT PRIMARY KEY,
      cc_session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Migration: dm_allowlist table for users allowed to interact via DMs
  db.exec(`
    CREATE TABLE IF NOT EXISTS dm_allowlist (
      user_id TEXT PRIMARY KEY,
      added_by TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );
  `);

  // Migration: tool_metrics — per-tool invocation telemetry so we can see
  // which tools are failing or slow via /toolstats.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_metrics (
      tool_name TEXT PRIMARY KEY,
      total_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      empty_count INTEGER NOT NULL DEFAULT 0,
      total_duration_ms INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_error_at INTEGER,
      last_called_at INTEGER
    );
  `);
}

export function logUsage(entry: {
  userId: string;
  sessionId?: string;
  keyId: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  costUsd?: number;
}): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO usage_log (user_id, session_id, key_id, tokens_in, tokens_out, model, cost_usd, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.userId,
    entry.sessionId || null,
    entry.keyId,
    entry.tokensIn,
    entry.tokensOut,
    entry.model,
    entry.costUsd || null,
    Date.now(),
  );
}

export interface UsageSummary {
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  models: Record<string, { requests: number; tokensIn: number; tokensOut: number }>;
}

export function getUsageSummary(userId?: string, sinceDaysAgo: number = 30): UsageSummary {
  const db = getDatabase();
  const since = Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000;

  const whereClause = userId
    ? 'WHERE timestamp >= ? AND user_id = ?'
    : 'WHERE timestamp >= ?';
  const params = userId ? [since, userId] : [since];

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      COALESCE(SUM(tokens_in), 0) as total_tokens_in,
      COALESCE(SUM(tokens_out), 0) as total_tokens_out,
      COALESCE(SUM(cost_usd), 0) as total_cost_usd
    FROM usage_log ${whereClause}
  `).get(...params) as any;

  const byModel = db.prepare(`
    SELECT
      model,
      COUNT(*) as requests,
      COALESCE(SUM(tokens_in), 0) as tokens_in,
      COALESCE(SUM(tokens_out), 0) as tokens_out
    FROM usage_log ${whereClause}
    GROUP BY model ORDER BY requests DESC
  `).all(...params) as any[];

  const models: Record<string, { requests: number; tokensIn: number; tokensOut: number }> = {};
  for (const row of byModel) {
    models[row.model || 'unknown'] = {
      requests: row.requests,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
    };
  }

  return {
    totalRequests: totals.total_requests,
    totalTokensIn: totals.total_tokens_in,
    totalTokensOut: totals.total_tokens_out,
    totalCostUsd: totals.total_cost_usd,
    models,
  };
}

export function saveConfigValue(key: string, value: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO bot_config (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

export function loadConfigValues(): Record<string, string> {
  const db = getDatabase();
  const rows = db.prepare('SELECT key, value FROM bot_config').all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function saveClaudeCodeSession(sessionKey: string, ccSessionId: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO claude_code_sessions (session_key, cc_session_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET cc_session_id = excluded.cc_session_id, updated_at = excluded.updated_at
  `).run(sessionKey, ccSessionId, Date.now());
}

export function loadClaudeCodeSessionMap(): Record<string, string> {
  const db = getDatabase();
  const rows = db.prepare('SELECT session_key, cc_session_id FROM claude_code_sessions').all() as { session_key: string; cc_session_id: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.session_key] = row.cc_session_id;
  }
  return result;
}

export function deleteClaudeCodeSession(sessionKey: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM claude_code_sessions WHERE session_key = ?').run(sessionKey);
}

// --- DM Allowlist ---

export function addDmAllowlistUser(userId: string, addedBy: string): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR REPLACE INTO dm_allowlist (user_id, added_by, added_at) VALUES (?, ?, ?)',
  ).run(userId, addedBy, Date.now());
}

export function removeDmAllowlistUser(userId: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM dm_allowlist WHERE user_id = ?').run(userId);
  return result.changes > 0;
}

export function isDmAllowlisted(userId: string): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT 1 FROM dm_allowlist WHERE user_id = ?').get(userId);
  return !!row;
}

export function listDmAllowlistUsers(): { user_id: string; added_by: string; added_at: number }[] {
  const db = getDatabase();
  return db.prepare('SELECT user_id, added_by, added_at FROM dm_allowlist ORDER BY added_at DESC').all() as {
    user_id: string;
    added_by: string;
    added_at: number;
  }[];
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
