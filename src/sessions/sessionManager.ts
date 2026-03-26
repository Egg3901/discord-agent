import { nanoid } from 'nanoid';
import { logger } from '../utils/logger.js';
import { SessionLimitError } from '../utils/errors.js';
import { config } from '../config.js';
import type { Session } from './session.js';
import type { RepoContext } from '../claude/contextBuilder.js';
import type { ConversationMessage } from '../claude/anthropicClient.js';

const STALE_SESSION_MS = 30 * 60 * 1000; // 30 minutes

export class SessionManager {
  private sessions: Map<string, Session> = new Map(); // threadId -> Session
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.pruneTimer = setInterval(() => this.pruneStale(), 5 * 60 * 1000);
  }

  createSession(
    userId: string,
    threadId: string,
    channelId: string,
    repoContext?: RepoContext,
  ): Session {
    // Check per-user limit
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
    logger.info({ sessionId: session.id, userId, threadId }, 'Session created');
    return session;
  }

  getByThread(threadId: string): Session | undefined {
    return this.sessions.get(threadId);
  }

  addMessage(threadId: string, message: ConversationMessage): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.messages.push(message);
      session.lastActiveAt = Date.now();
    }
  }

  endSession(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (session) {
      this.sessions.delete(threadId);
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
        pruned++;
        logger.info({ sessionId: session.id }, 'Stale session pruned');
      }
    }
    return pruned;
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
    this.sessions.clear();
  }
}
