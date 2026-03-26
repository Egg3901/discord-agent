import { type GuildMember, PermissionFlagsBits } from 'discord.js';

/**
 * Check if a user has admin privileges.
 * Uses Discord's built-in Administrator permission — no hardcoded IDs needed.
 */
export function isAdmin(member: GuildMember | null): boolean {
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}
