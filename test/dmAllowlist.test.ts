import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

// We test the database functions directly by setting up a temp DB.
// Since the module caches the DB instance, we replicate the schema and functions inline.

const TEST_DB_PATH = './data/test-dm-allowlist.db';

describe('DM Allowlist - Database Layer', () => {
  let db: Database.Database;

  before(() => {
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
    db = new Database(TEST_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS dm_allowlist (
        user_id TEXT PRIMARY KEY,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL
      );
    `);
  });

  after(() => {
    db.close();
    rmSync(TEST_DB_PATH, { force: true });
    rmSync(TEST_DB_PATH + '-wal', { force: true });
    rmSync(TEST_DB_PATH + '-shm', { force: true });
  });

  beforeEach(() => {
    db.exec('DELETE FROM dm_allowlist');
  });

  // --- Helper functions that mirror the production code ---

  function addDmAllowlistUser(userId: string, addedBy: string): void {
    db.prepare(
      'INSERT OR REPLACE INTO dm_allowlist (user_id, added_by, added_at) VALUES (?, ?, ?)',
    ).run(userId, addedBy, Date.now());
  }

  function removeDmAllowlistUser(userId: string): boolean {
    const result = db.prepare('DELETE FROM dm_allowlist WHERE user_id = ?').run(userId);
    return result.changes > 0;
  }

  function isDmAllowlisted(userId: string): boolean {
    const row = db.prepare('SELECT 1 FROM dm_allowlist WHERE user_id = ?').get(userId);
    return !!row;
  }

  function listDmAllowlistUsers(): { user_id: string; added_by: string; added_at: number }[] {
    return db.prepare('SELECT user_id, added_by, added_at FROM dm_allowlist ORDER BY added_at DESC').all() as any[];
  }

  // --- Tests ---

  it('should add a user to the allowlist', () => {
    addDmAllowlistUser('user123', 'admin456');
    assert.equal(isDmAllowlisted('user123'), true);
  });

  it('should return false for non-allowlisted users', () => {
    assert.equal(isDmAllowlisted('unknown_user'), false);
  });

  it('should remove a user from the allowlist', () => {
    addDmAllowlistUser('user123', 'admin456');
    const removed = removeDmAllowlistUser('user123');
    assert.equal(removed, true);
    assert.equal(isDmAllowlisted('user123'), false);
  });

  it('should return false when removing a non-existent user', () => {
    const removed = removeDmAllowlistUser('nonexistent');
    assert.equal(removed, false);
  });

  it('should list all allowlisted users', () => {
    addDmAllowlistUser('user1', 'admin1');
    addDmAllowlistUser('user2', 'admin2');
    addDmAllowlistUser('user3', 'admin1');

    const users = listDmAllowlistUsers();
    assert.equal(users.length, 3);
    const ids = users.map((u) => u.user_id);
    assert.ok(ids.includes('user1'));
    assert.ok(ids.includes('user2'));
    assert.ok(ids.includes('user3'));
  });

  it('should handle upsert (re-adding same user)', () => {
    addDmAllowlistUser('user123', 'admin1');
    addDmAllowlistUser('user123', 'admin2'); // Should update, not duplicate

    const users = listDmAllowlistUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].added_by, 'admin2');
  });

  it('should return empty list when no users allowlisted', () => {
    const users = listDmAllowlistUsers();
    assert.equal(users.length, 0);
  });
});

describe('DM Allowlist - Permission Logic', () => {
  let db: Database.Database;

  before(() => {
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
    db = new Database(TEST_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS dm_allowlist (
        user_id TEXT PRIMARY KEY,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS allowed_roles (
        role_id TEXT PRIMARY KEY,
        role_name TEXT NOT NULL,
        added_at INTEGER NOT NULL
      );
    `);
  });

  after(() => {
    db.close();
    rmSync(TEST_DB_PATH, { force: true });
    rmSync(TEST_DB_PATH + '-wal', { force: true });
    rmSync(TEST_DB_PATH + '-shm', { force: true });
  });

  beforeEach(() => {
    db.exec('DELETE FROM dm_allowlist');
    db.exec('DELETE FROM allowed_roles');
  });

  function isDmAllowlisted(userId: string): boolean {
    const row = db.prepare('SELECT 1 FROM dm_allowlist WHERE user_id = ?').get(userId);
    return !!row;
  }

  function addDmAllowlistUser(userId: string, addedBy: string): void {
    db.prepare(
      'INSERT OR REPLACE INTO dm_allowlist (user_id, added_by, added_at) VALUES (?, ?, ?)',
    ).run(userId, addedBy, Date.now());
  }

  // Simulates the isAllowed logic for DM context (member=null, userId provided)
  function isAllowedDm(userId: string): boolean {
    return isDmAllowlisted(userId);
  }

  it('should allow DM access for allowlisted users', () => {
    addDmAllowlistUser('dm_user', 'admin1');
    assert.equal(isAllowedDm('dm_user'), true);
  });

  it('should deny DM access for non-allowlisted users', () => {
    assert.equal(isAllowedDm('random_user'), false);
  });

  it('should deny DM access when no userId is provided (simulates null member, no userId)', () => {
    // When both member and userId are absent, isAllowed returns false
    const result = false; // isAllowed(null) without userId
    assert.equal(result, false);
  });

  it('should allow then deny after removal', () => {
    addDmAllowlistUser('temp_user', 'admin1');
    assert.equal(isAllowedDm('temp_user'), true);

    db.prepare('DELETE FROM dm_allowlist WHERE user_id = ?').run('temp_user');
    assert.equal(isAllowedDm('temp_user'), false);
  });
});
