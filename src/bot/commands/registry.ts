import { REST, Routes } from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';

export async function registerCommands(commands: CommandHandler[]): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

  const commandData = commands.map((cmd) => cmd.data.toJSON());

  try {
    if (config.DISCORD_GUILD_ID) {
      // Register to specific guild (instant)
      await rest.put(
        Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
        { body: commandData },
      );
      logger.info(
        { guild: config.DISCORD_GUILD_ID, count: commandData.length },
        'Registered guild commands',
      );

      // Clear stale global commands so they don't shadow guild commands
      try {
        const globalCmds = await rest.get(Routes.applicationCommands(config.DISCORD_CLIENT_ID)) as any[];
        if (globalCmds.length > 0) {
          await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), { body: [] });
          logger.info({ cleared: globalCmds.length }, 'Cleared stale global commands');
        }
      } catch {
        // Non-fatal — global commands will eventually expire
      }
    } else {
      // Register globally (takes up to 1 hour to propagate)
      await rest.put(
        Routes.applicationCommands(config.DISCORD_CLIENT_ID),
        { body: commandData },
      );
      logger.info({ count: commandData.length }, 'Registered global commands');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to register commands');
    throw err;
  }
}
