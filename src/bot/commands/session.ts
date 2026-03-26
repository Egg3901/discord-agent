import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import type { CommandHandler } from './types.js';

export function createSessionCommand(
  sessionManager: SessionManager,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('session')
      .setDescription('Manage your coding sessions')
      .addSubcommand((sub) =>
        sub.setName('end').setDescription('End the current session in this thread'),
      )
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('View your active sessions'),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'end') {
        const threadId = interaction.channelId;
        const session = sessionManager.getByThread(threadId);

        if (!session) {
          await interaction.reply({
            content: 'No active session in this thread.',
            ephemeral: true,
          });
          return;
        }

        if (session.userId !== interaction.user.id) {
          await interaction.reply({
            content: 'You can only end your own sessions.',
            ephemeral: true,
          });
          return;
        }

        sessionManager.endSession(threadId);
        await interaction.reply('Session ended. This thread is now inactive.');
      }

      if (subcommand === 'status') {
        const sessions = sessionManager
          .getActiveSessions()
          .filter((s) => s.userId === interaction.user.id);

        if (sessions.length === 0) {
          await interaction.reply({
            content: 'You have no active sessions.',
            ephemeral: true,
          });
          return;
        }

        const lines = sessions.map(
          (s) =>
            `• <#${s.threadId}> — ${s.messages.length} messages — started <t:${Math.floor(s.createdAt / 1000)}:R>`,
        );

        await interaction.reply({
          content: `**Your active sessions (${sessions.length}):**\n${lines.join('\n')}`,
          ephemeral: true,
        });
      }
    },
  };
}
