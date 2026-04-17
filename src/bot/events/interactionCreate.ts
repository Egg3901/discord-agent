import { Client, type Interaction } from 'discord.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from '../commands/types.js';

export function handleInteractionCreate(
  client: Client,
  commands: Map<string, CommandHandler>,
): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    // Autocomplete for slash commands
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

    if (interaction.isChatInputCommand()) {
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
      return;
    }

    // Buttons / modals / select menus are normally handled by per-message
    // component collectors. If one expires (e.g. 2-minute window on
    // next-step buttons elapses before the click), the interaction still
    // fires here — acknowledge it so the user isn't left staring at a
    // silent "Interaction failed" toast.
    if (
      interaction.isButton() ||
      interaction.isAnySelectMenu() ||
      interaction.isModalSubmit()
    ) {
      logger.debug(
        { customId: (interaction as any).customId, type: interaction.type },
        'Component interaction with no active collector',
      );
      try {
        await interaction.reply({
          content: 'This control has expired. Send a message to continue the conversation.',
          ephemeral: true,
        });
      } catch {
        // Already acked or timed out — ignore.
      }
    }
  });
}
