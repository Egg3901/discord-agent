import { REST, Routes } from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';

export async function registerCommands(commands: CommandHandler[]): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

  const commandData = commands.map((cmd) => cmd.data.toJSON());

  try {
    if (config.DISCORD_GUILD_ID) {
      // Register to specific guild (instant, for development)
      await rest.put(
        Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
        { body: commandData },
      );
      logger.info(
        { guild: config.DISCORD_GUILD_ID, count: commandData.length },
        'Registered guild commands',
      );
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
