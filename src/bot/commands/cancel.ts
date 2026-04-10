import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { isAdmin } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import type { CommandHandler } from './types.js';

export function createCancelCommand(
  sessionManager: SessionManager,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('cancel')
      .setDescription('Cancel the current in-flight AI response'),

    async execute(interaction: ChatInputCommandInteraction) {
      try {
        if (!isAdmin(interaction.member as GuildMember | null)) {
          await interaction.reply({ content: 'This command requires administrator permissions.', ephemeral: true });
          return;
        }

        const session = sessionManager.getByThread(interaction.channelId);
        if (!session) {
          await interaction.reply({ content: 'No active session in this thread.', ephemeral: true });
          return;
        }

        // Only the session owner can cancel
        if (session.userId !== interaction.user.id) {
          await interaction.reply({ content: 'Only the session owner can cancel.', ephemeral: true });
          return;
        }

        if (!session.activeController) {
          await interaction.reply({ content: 'Nothing is running right now.', ephemeral: true });
          return;
        }

        session.activeController?.abort();
        session.activeController = undefined;
        await interaction.reply({ content: 'Cancelled.', ephemeral: true });
      } catch (err) {
        await interaction.reply({ content: formatApiError(err), ephemeral: true }).catch(() => {});
      }
    },
  };
}
