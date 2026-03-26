import { config } from '../../config.js';

interface RateLimitEntry {
  timestamps: number[];
}

const windowMs = 60_000;

export class RateLimiter {
  private entries: Map<string, RateLimitEntry> = new Map();

  /**
   * Check if a user is rate limited. Returns true if allowed, false if limited.
   */
  check(userId: string): boolean {
    const now = Date.now();
    let entry = this.entries.get(userId);
    if (!entry) {
      entry = { timestamps: [] };
      this.entries.set(userId, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= config.MAX_REQUESTS_PER_MINUTE) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /**
   * Get remaining requests for a user in the current window.
   */
  remaining(userId: string): number {
    const now = Date.now();
    const entry = this.entries.get(userId);
    if (!entry) return config.MAX_REQUESTS_PER_MINUTE;

    const recent = entry.timestamps.filter((t) => now - t < windowMs);
    return Math.max(0, config.MAX_REQUESTS_PER_MINUTE - recent.length);
  }
}
