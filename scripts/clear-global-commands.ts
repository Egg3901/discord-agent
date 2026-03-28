/**
 * Clear stale global slash commands.
 * Run this once after switching to guild-scoped registration (DISCORD_GUILD_ID).
 *
 * Usage: npx tsx scripts/clear-global-commands.ts
 */
import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const token = process.env['DISCORD_TOKEN'];
const clientId = process.env['DISCORD_CLIENT_ID'];

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

try {
  await rest.put(Routes.applicationCommands(clientId), { body: [] });
  console.log('Global commands cleared. Guild commands will now take effect immediately.');
} catch (err) {
  console.error('Failed to clear global commands:', err);
  process.exit(1);
}
