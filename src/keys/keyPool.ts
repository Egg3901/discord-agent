import { nanoid } from 'nanoid';
import { logger } from '../utils/logger.js';
import { KeyExhaustedError, QueueTimeoutError } from '../utils/errors.js';
import { KeyStore } from './keyStore.js';
import type { ManagedKey, AcquiredKey, KeyPoolStats } from './types.js';

interface QueueEntry {
  resolve: (value: AcquiredKey) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  position: number;
  onPositionChange?: (pos: number) => void;
}

const QUEUE_TIMEOUT_MS = 60_000;
const MAX_QUEUE_SIZE = 50;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const RESURRECTION_BACKOFF_MS = 120_000; // dead keys wait 2 min before retry
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export class KeyPool {
  private keys: Map<string, ManagedKey> = new Map();
  private queue: QueueEntry[] = [];
  private store: KeyStore;
  private minuteResetTimer: ReturnType<typeof setInterval>;
  private dayResetTimer: ReturnType<typeof setInterval>;
  private healthCheckTimer: ReturnType<typeof setInterval>;
  private persistTimer: ReturnType<typeof setInterval>;

  constructor(initialApiKeys: string[]) {
    this.store = new KeyStore();

    // Load persisted keys from database first
    const stored = this.store.loadAll();
    for (const row of stored) {
      const key: ManagedKey = {
        id: row.id,
        apiKey: row.api_key,
        status: 'healthy',
        requestsThisMinute: 0,
        requestsToday: 0,
        totalRequests: row.total_requests,
        lastUsed: 0,
        consecutiveFailures: 0,
        rateLimitResetAt: null,
      };
      this.keys.set(row.id, key);
    }

    if (stored.length > 0) {
      logger.info({ count: stored.length }, 'Loaded API keys from database');
    }

    // Add any env-provided keys that aren't already in DB
    for (const apiKey of initialApiKeys) {
      const alreadyExists = [...this.keys.values()].some((k) => k.apiKey === apiKey);
      if (!alreadyExists) {
        this.addKey(apiKey, 'env');
      }
    }

    this.minuteResetTimer = setInterval(() => {
      for (const key of this.keys.values()) {
        key.requestsThisMinute = 0;
      }
    }, MINUTE_MS);

    this.dayResetTimer = setInterval(() => {
      for (const key of this.keys.values()) {
        key.requestsToday = 0;
      }
    }, DAY_MS);

    this.healthCheckTimer = setInterval(() => {
      this.resurrectDeadKeys();
    }, HEALTH_CHECK_INTERVAL_MS);

    // Persist request counts every 5 minutes
    this.persistTimer = setInterval(() => {
      this.persistStats();
    }, 5 * MINUTE_MS);
  }

  addKey(apiKey: string, addedBy: string = 'admin'): string {
    // Check for duplicate
    for (const existing of this.keys.values()) {
      if (existing.apiKey === apiKey) {
        return existing.id;
      }
    }

    const id = nanoid(8);
    const key: ManagedKey = {
      id,
      apiKey,
      status: 'healthy',
      requestsThisMinute: 0,
      requestsToday: 0,
      totalRequests: 0,
      lastUsed: 0,
      consecutiveFailures: 0,
      rateLimitResetAt: null,
    };
    this.keys.set(id, key);
    this.store.save(id, apiKey, addedBy);
    logger.info({ keyId: id }, 'API key added to pool and persisted');

    // Drain queue now that a new key is available
    this.drainQueue();

    return id;
  }

  removeKey(id: string): boolean {
    const removed = this.keys.delete(id);
    if (removed) {
      this.store.remove(id);
      logger.info({ keyId: id }, 'API key removed from pool and database');
    }
    return removed;
  }

  /**
   * Acquire a key from the pool. If no key is available, queues the request.
   * Returns a queue position callback so callers can report position to users.
   */
  async acquire(onPositionChange?: (position: number) => void): Promise<AcquiredKey> {
    if (this.keys.size === 0) {
      throw new KeyExhaustedError();
    }

    const key = this.selectKey();
    if (key) {
      return this.wrapKey(key);
    }

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      throw new KeyExhaustedError();
    }

    // No key available — queue the request
    return new Promise<AcquiredKey>((resolve, reject) => {
      const position = this.queue.length + 1;

      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        this.updateQueuePositions();
        reject(new QueueTimeoutError());
      }, QUEUE_TIMEOUT_MS);

      this.queue.push({ resolve, reject, timer, position, onPositionChange });

      if (onPositionChange) {
        onPositionChange(position);
      }

      logger.debug({ queueDepth: this.queue.length }, 'Request queued');
    });
  }

  getStats(): KeyPoolStats {
    let healthy = 0,
      degraded = 0,
      dead = 0,
      requestsThisMinute = 0;
    for (const key of this.keys.values()) {
      if (key.status === 'healthy') healthy++;
      else if (key.status === 'degraded') degraded++;
      else dead++;
      requestsThisMinute += key.requestsThisMinute;
    }
    return {
      total: this.keys.size,
      healthy,
      degraded,
      dead,
      queueDepth: this.queue.length,
      requestsThisMinute,
    };
  }

  getKeys(): ManagedKey[] {
    return [...this.keys.values()];
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  destroy(): void {
    clearInterval(this.minuteResetTimer);
    clearInterval(this.dayResetTimer);
    clearInterval(this.healthCheckTimer);
    clearInterval(this.persistTimer);
    this.persistStats();
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Pool destroyed'));
    }
    this.queue = [];
  }

  private selectKey(): ManagedKey | null {
    const now = Date.now();
    let best: ManagedKey | null = null;

    for (const key of this.keys.values()) {
      if (key.status === 'dead') continue;

      if (key.status === 'degraded' && key.rateLimitResetAt && now < key.rateLimitResetAt) {
        continue;
      }

      // If degraded key has passed reset time, mark as healthy
      if (key.status === 'degraded' && key.rateLimitResetAt && now >= key.rateLimitResetAt) {
        key.status = 'healthy';
        key.rateLimitResetAt = null;
        key.consecutiveFailures = 0;
      }

      if (!best || key.requestsThisMinute < best.requestsThisMinute) {
        best = key;
      }
    }

    return best;
  }

  private wrapKey(key: ManagedKey): AcquiredKey {
    key.requestsThisMinute++;
    key.requestsToday++;
    key.totalRequests++;
    key.lastUsed = Date.now();

    const release = (success: boolean) => {
      if (success) {
        key.consecutiveFailures = 0;
        if (key.status === 'degraded') {
          key.status = 'healthy';
          key.rateLimitResetAt = null;
        }
      } else {
        key.consecutiveFailures++;
        if (key.consecutiveFailures >= 3) {
          key.status = 'dead';
          // Dead keys won't be retried until resurrectDeadKeys runs
          key.rateLimitResetAt = Date.now() + RESURRECTION_BACKOFF_MS;
          logger.warn({ keyId: key.id }, 'Key marked as dead after 3 consecutive failures');
        } else {
          key.status = 'degraded';
          key.rateLimitResetAt = Date.now() + 60_000;
          logger.warn({ keyId: key.id, failures: key.consecutiveFailures }, 'Key marked as degraded');
        }
      }

      this.drainQueue();
    };

    return { key, release };
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const nextKey = this.selectKey();
      if (!nextKey) break;

      const entry = this.queue.shift()!;
      clearTimeout(entry.timer);
      entry.resolve(this.wrapKey(nextKey));
    }
    this.updateQueuePositions();
  }

  private updateQueuePositions(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      const newPos = i + 1;
      if (entry.position !== newPos) {
        entry.position = newPos;
        entry.onPositionChange?.(newPos);
      }
    }
  }

  private resurrectDeadKeys(): void {
    const now = Date.now();
    for (const key of this.keys.values()) {
      if (key.status === 'dead' && key.rateLimitResetAt && now >= key.rateLimitResetAt) {
        key.status = 'degraded';
        key.rateLimitResetAt = now + 1000; // small grace period
        key.consecutiveFailures = 0;
        logger.info({ keyId: key.id }, 'Resurrecting dead key for retry');
      }
    }
    this.drainQueue();
  }

  private persistStats(): void {
    for (const key of this.keys.values()) {
      try {
        this.store.updateRequestCount(key.id, key.totalRequests);
      } catch {
        // Ignore persistence errors
      }
    }
  }
}
