import { getDatabase } from '../storage/database.js';
import { logger } from '../utils/logger.js';

export interface StoredKey {
  id: string;
  api_key: string;
  added_at: number;
  added_by: string;
  total_requests: number;
  is_active: number;
}

export class KeyStore {
  loadAll(): StoredKey[] {
    const db = getDatabase();
    return db.prepare('SELECT * FROM api_keys WHERE is_active = 1').all() as StoredKey[];
  }

  save(id: string, apiKey: string, addedBy: string = 'system'): void {
    const db = getDatabase();
    db.prepare(
      'INSERT OR REPLACE INTO api_keys (id, api_key, added_at, added_by, total_requests, is_active) VALUES (?, ?, ?, ?, 0, 1)',
    ).run(id, apiKey, Date.now(), addedBy);
  }

  remove(id: string): boolean {
    const db = getDatabase();
    const result = db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  updateRequestCount(id: string, totalRequests: number): void {
    const db = getDatabase();
    db.prepare('UPDATE api_keys SET total_requests = ? WHERE id = ?').run(totalRequests, id);
  }
}
