import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import type { CommandHandler } from './types.js';

export function createCancelCommand(
  sessionManager: SessionManager,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('cancel')
      .setDescription('Cancel the current in-flight AI response'),

    async execute(interaction: ChatInputCommandInteraction) {
      const session = sessionManager.getByThread(interaction.channelId);
      if (!session) {
        await interaction.reply({
          content: 'No active session in this thread.',
          ephemeral: true,
        });
        return;
      }

      if (!session.activeController) {
        await interaction.reply({
          content: 'Nothing is running right now.',
          ephemeral: true,
        });
        return;
      }

      session.activeController.abort();
      session.activeController = undefined;
      await interaction.reply('Cancelled.');
    },
  };
}
