import { type GuildMember, PermissionFlagsBits } from 'discord.js';
import { getDatabase } from '../../storage/database.js';

/**
 * Check if a user has admin privileges.
 * Uses Discord's built-in Administrator permission.
 */
export function isAdmin(member: GuildMember | null): boolean {
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

/**
 * Check if a user is allowed to use the bot.
 * If no roles are configured in allowed_roles, everyone can use it.
 * If roles are configured, user must have one of them (or be admin).
 */
export function isAllowed(member: GuildMember | null): boolean {
  if (!member) return false;
  if (isAdmin(member)) return true;

  const allowedRoles = getAllowedRoles();
  if (allowedRoles.length === 0) return true; // No restriction

  return member.roles.cache.some((role) => allowedRoles.includes(role.id));
}

// --- Role management (stored in SQLite, cached in memory) ---

let cachedRoles: string[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

export function getAllowedRoles(): string[] {
  const now = Date.now();
  if (cachedRoles && now < cacheExpiry) return cachedRoles;
  const db = getDatabase();
  const rows = db.prepare('SELECT role_id FROM allowed_roles').all() as { role_id: string }[];
  cachedRoles = rows.map((r) => r.role_id);
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedRoles;
}

/** Invalidate the role cache (called after add/remove). */
function invalidateRoleCache(): void {
  cachedRoles = null;
  cacheExpiry = 0;
}

export function addAllowedRole(roleId: string, roleName: string): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR REPLACE INTO allowed_roles (role_id, role_name, added_at) VALUES (?, ?, ?)',
  ).run(roleId, roleName, Date.now());
  invalidateRoleCache();
}

export function removeAllowedRole(roleId: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM allowed_roles WHERE role_id = ?').run(roleId);
  invalidateRoleCache();
  return result.changes > 0;
}

export function listAllowedRoles(): { role_id: string; role_name: string }[] {
  const db = getDatabase();
  return db.prepare('SELECT role_id, role_name FROM allowed_roles').all() as {
    role_id: string;
    role_name: string;
  }[];
}
