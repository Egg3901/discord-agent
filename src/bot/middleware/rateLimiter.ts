import { config } from '../../config.js';

interface RateLimitEntry {
  timestamps: number[];
}

const windowMs = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

export class RateLimiter {
  private entries: Map<string, RateLimitEntry> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Periodically clean up stale entries to prevent memory leak
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  check(userId: string): boolean {
    const now = Date.now();
    let entry = this.entries.get(userId);
    if (!entry) {
      entry = { timestamps: [] };
      this.entries.set(userId, entry);
    }

    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= config.MAX_REQUESTS_PER_MINUTE) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  remaining(userId: string): number {
    const now = Date.now();
    const entry = this.entries.get(userId);
    if (!entry) return config.MAX_REQUESTS_PER_MINUTE;

    const recent = entry.timestamps.filter((t) => now - t < windowMs);
    return Math.max(0, config.MAX_REQUESTS_PER_MINUTE - recent.length);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [userId, entry] of this.entries) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
      if (entry.timestamps.length === 0) {
        this.entries.delete(userId);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.entries.clear();
  }
}
