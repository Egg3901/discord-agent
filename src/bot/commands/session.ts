import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { isAllowed } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
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
      )
      .addSubcommand((sub) =>
        sub.setName('reset').setDescription('Reset the conversation (clear history, start fresh CC session)'),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAllowed(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'You do not have a role that allows using this bot.',
          ephemeral: true,
        });
        return;
      }

      try {
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

        if (subcommand === 'reset') {
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
              content: 'You can only reset your own sessions.',
              ephemeral: true,
            });
            return;
          }

          session.messages = [];
          // Clear CC session ID so next message starts fresh
          import('../../storage/database.js').then(({ deleteClaudeCodeSession }) => {
            deleteClaudeCodeSession(session.id);
          }).catch(() => {});
          await interaction.reply({ content: 'Session reset. Conversation history cleared and CC session restarted.', ephemeral: true });
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
      } catch (err) {
        const msg = formatApiError(err);
        if (interaction.deferred) {
          await interaction.editReply(msg).catch(() => {});
        } else {
          await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        }
      }
    },
  };
}
