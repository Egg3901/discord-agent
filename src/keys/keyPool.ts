import { nanoid } from 'nanoid';
import { logger } from '../utils/logger.js';
import { KeyExhaustedError, QueueTimeoutError } from '../utils/errors.js';
import type { ManagedKey, AcquiredKey, KeyPoolStats } from './types.js';

interface QueueEntry {
  resolve: (value: AcquiredKey) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const QUEUE_TIMEOUT_MS = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export class KeyPool {
  private keys: Map<string, ManagedKey> = new Map();
  private queue: QueueEntry[] = [];
  private minuteResetTimer: ReturnType<typeof setInterval>;
  private dayResetTimer: ReturnType<typeof setInterval>;
  private healthCheckTimer: ReturnType<typeof setInterval>;

  constructor(apiKeys: string[]) {
    for (const apiKey of apiKeys) {
      this.addKey(apiKey);
    }

    // Reset per-minute counters every minute
    this.minuteResetTimer = setInterval(() => {
      for (const key of this.keys.values()) {
        key.requestsThisMinute = 0;
      }
    }, MINUTE_MS);

    // Reset daily counters every day
    this.dayResetTimer = setInterval(() => {
      for (const key of this.keys.values()) {
        key.requestsToday = 0;
      }
    }, DAY_MS);

    // Health check dead keys periodically
    this.healthCheckTimer = setInterval(() => {
      this.resurrectDegradedKeys();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  addKey(apiKey: string): string {
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
    logger.info({ keyId: id }, 'API key added to pool');
    return id;
  }

  removeKey(id: string): boolean {
    const removed = this.keys.delete(id);
    if (removed) {
      logger.info({ keyId: id }, 'API key removed from pool');
    }
    return removed;
  }

  /**
   * Acquire a key from the pool. If no key is available, queues the request.
   */
  async acquire(): Promise<AcquiredKey> {
    const key = this.selectKey();
    if (key) {
      return this.wrapKey(key);
    }

    // No key available — queue the request
    return new Promise<AcquiredKey>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new QueueTimeoutError());
      }, QUEUE_TIMEOUT_MS);

      this.queue.push({ resolve, reject, timer });
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
      // Skip dead keys
      if (key.status === 'dead') continue;

      // Skip degraded keys that haven't reached their reset time
      if (key.status === 'degraded' && key.rateLimitResetAt && now < key.rateLimitResetAt) {
        continue;
      }

      // If degraded key has passed reset time, mark as healthy
      if (key.status === 'degraded' && key.rateLimitResetAt && now >= key.rateLimitResetAt) {
        key.status = 'healthy';
        key.rateLimitResetAt = null;
        key.consecutiveFailures = 0;
      }

      // Pick the key with the fewest requests this minute
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
          logger.warn({ keyId: key.id }, 'Key marked as dead after 3 consecutive failures');
        } else {
          key.status = 'degraded';
          // Default: back off for 60 seconds
          key.rateLimitResetAt = Date.now() + 60_000;
          logger.warn({ keyId: key.id, failures: key.consecutiveFailures }, 'Key marked as degraded');
        }
      }

      // Try to drain the queue
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
  }

  private resurrectDegradedKeys(): void {
    const now = Date.now();
    for (const key of this.keys.values()) {
      if (key.status === 'dead') {
        // Give dead keys another chance after health check interval
        key.status = 'degraded';
        key.rateLimitResetAt = now;
        key.consecutiveFailures = 0;
        logger.info({ keyId: key.id }, 'Resurrecting dead key for retry');
      }
    }
  }
}
