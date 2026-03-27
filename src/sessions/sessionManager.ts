import { nanoid } from 'nanoid';
import { logger } from '../utils/logger.js';
import { SessionLimitError } from '../utils/errors.js';
import { config } from '../config.js';
import { getDatabase } from '../storage/database.js';
import { cleanupSandbox } from '../tools/scriptExecutor.js';
import type { Session } from './session.js';
import type { RepoContext } from '../claude/contextBuilder.js';
import type { ConversationMessage } from '../claude/aiClient.js';

const STALE_SESSION_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES_PER_SESSION = 100;
const PERSIST_INTERVAL_MS = 60_000; // persist every minute

export class SessionManager {
  private sessions: Map<string, Session> = new Map(); // threadId -> Session
  private pruneTimer: ReturnType<typeof setInterval>;
  private persistTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.loadFromDatabase();
    this.pruneTimer = setInterval(() => this.pruneStale(), 5 * 60 * 1000);
    this.persistTimer = setInterval(() => this.persistAll(), PERSIST_INTERVAL_MS);
  }

  createSession(
    userId: string,
    threadId: string,
    channelId: string,
    repoContext?: RepoContext,
  ): Session {
    const userCount = this.getActiveSessionCount(userId);
    if (userCount >= config.MAX_SESSIONS_PER_USER) {
      throw new SessionLimitError(config.MAX_SESSIONS_PER_USER);
    }

    const session: Session = {
      id: nanoid(12),
      userId,
      threadId,
      channelId,
      messages: [],
      repoContext,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.sessions.set(threadId, session);
    this.persistSession(session);
    logger.info({ sessionId: session.id, userId, threadId }, 'Session created');
    return session;
  }

  getByThread(threadId: string): Session | undefined {
    return this.sessions.get(threadId);
  }

  addMessage(threadId: string, message: ConversationMessage): void {
    const session = this.sessions.get(threadId);
    if (!session) return;

    session.messages.push(message);
    session.lastActiveAt = Date.now();

    // Cap messages to prevent unbounded memory growth
    if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
      const first = session.messages[0];
      const trimNotice = '[Earlier messages trimmed due to session length]';
      // Check if a trim notice already exists (second message)
      const hasTrimNotice =
        session.messages.length > 1 &&
        typeof session.messages[1].content === 'string' &&
        session.messages[1].content === trimNotice;

      if (hasTrimNotice) {
        // Keep first message + trim notice + last N
        session.messages = [
          first,
          session.messages[1],
          ...session.messages.slice(-(MAX_MESSAGES_PER_SESSION - 2)),
        ];
      } else {
        // Insert trim notice for the first time
        session.messages = [
          first,
          { role: 'user', content: trimNotice },
          ...session.messages.slice(-(MAX_MESSAGES_PER_SESSION - 2)),
        ];
      }
    }
  }

  endSession(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (session) {
      this.sessions.delete(threadId);
      this.deleteSessionFromDb(session.id);
      cleanupSandbox(session.id).catch(() => {});
      logger.info({ sessionId: session.id, threadId }, 'Session ended');
      return true;
    }
    return false;
  }

  getActiveSessionCount(userId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) count++;
    }
    return count;
  }

  getActiveSessions(): Session[] {
    return [...this.sessions.values()];
  }

  pruneStale(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [threadId, session] of this.sessions) {
      if (now - session.lastActiveAt > STALE_SESSION_MS) {
        this.sessions.delete(threadId);
        this.deleteSessionFromDb(session.id);
        cleanupSandbox(session.id).catch(() => {});
        pruned++;
        logger.info({ sessionId: session.id }, 'Stale session pruned');
      }
    }
    return pruned;
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
    clearInterval(this.persistTimer);
    this.persistAll();
    this.sessions.clear();
  }

  // --- Database persistence ---

  private loadFromDatabase(): void {
    try {
      const db = getDatabase();
      const rows = db.prepare(
        'SELECT * FROM sessions WHERE last_active_at > ?',
      ).all(Date.now() - STALE_SESSION_MS) as any[];

      for (const row of rows) {
        const session: Session = {
          id: row.id,
          userId: row.user_id,
          threadId: row.thread_id,
          channelId: row.channel_id,
          messages: JSON.parse(row.messages || '[]'),
          repoContext: row.repo_context ? JSON.parse(row.repo_context) : undefined,
          modelOverride: row.model_override || undefined,
          createdAt: row.created_at,
          lastActiveAt: row.last_active_at,
        };
        this.sessions.set(row.thread_id, session);
      }

      if (rows.length > 0) {
        logger.info({ count: rows.length }, 'Restored sessions from database');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load sessions from database (starting fresh)');
    }
  }

  private persistSession(session: Session): void {
    try {
      const db = getDatabase();
      db.prepare(`
        INSERT OR REPLACE INTO sessions
          (id, user_id, thread_id, channel_id, messages, repo_context, created_at, last_active_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        session.userId,
        session.threadId,
        session.channelId,
        JSON.stringify(session.messages),
        session.repoContext ? JSON.stringify(session.repoContext) : null,
        session.createdAt,
        session.lastActiveAt,
      );
    } catch (err) {
      logger.error({ err, sessionId: session.id }, 'Failed to persist session');
    }
  }

  private persistAll(): void {
    for (const session of this.sessions.values()) {
      this.persistSession(session);
    }
  }

  private deleteSessionFromDb(sessionId: string): void {
    try {
      const db = getDatabase();
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    } catch {
      // Ignore
    }
  }
}
