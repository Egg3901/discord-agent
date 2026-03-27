import { Client, type Interaction } from 'discord.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from '../commands/types.js';

export function handleInteractionCreate(
  client: Client,
  commands: Map<string, CommandHandler>,
): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    // Handle autocomplete interactions
    if (interaction.isAutocomplete()) {
      const handler = commands.get(interaction.commandName);
      if (handler?.autocomplete) {
        try {
          await handler.autocomplete(interaction);
        } catch (err) {
          logger.warn({ err, command: interaction.commandName }, 'Autocomplete error');
          await interaction.respond([]).catch(() => {});
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const handler = commands.get(interaction.commandName);
    if (!handler) {
      logger.warn({ command: interaction.commandName }, 'Unknown command');
      return;
    }

    try {
      await handler.execute(interaction);
    } catch (err) {
      logger.error({ err, command: interaction.commandName }, 'Command error');

      const content = 'An error occurred while processing your command.';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  });
}
