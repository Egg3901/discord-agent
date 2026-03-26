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

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_thread_id ON sessions(thread_id);
    CREATE INDEX IF NOT EXISTS idx_usage_log_user_id ON usage_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_log_timestamp ON usage_log(timestamp);
  `);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
