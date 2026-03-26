import type { Client } from 'discord.js';
import { logger } from '../../utils/logger.js';

export function handleReady(client: Client): void {
  client.on('ready', () => {
    logger.info(
      { user: client.user?.tag, guilds: client.guilds.cache.size },
      'Bot is online',
    );
  });
}
