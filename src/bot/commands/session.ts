import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import type { AIClient } from '../../claude/aiClient.js';
import { isAdmin } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import { BotColors, formatDuration } from '../../utils/embedHelpers.js';
import type { CommandHandler } from './types.js';

export function createSessionCommand(
  sessionManager: SessionManager,
  aiClient?: AIClient,
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
      if (!isAdmin(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'This command requires administrator permissions.',
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
            await interaction.reply({ content: 'No active session in this thread.', ephemeral: true });
            return;
          }

          if (session.userId !== interaction.user.id) {
            await interaction.reply({ content: 'You can only end your own sessions.', ephemeral: true });
            return;
          }

          const duration = formatDuration(Date.now() - session.createdAt);
          const msgCount = session.messages.length;
          sessionManager.endSession(threadId);

          const embed = new EmbedBuilder()
            .setColor(BotColors.Neutral)
            .setTitle('Session Ended')
            .setDescription('This thread is now inactive.')
            .addFields(
              { name: 'Duration', value: duration, inline: true },
              { name: 'Messages', value: `${msgCount}`, inline: true },
            )
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
        }

        if (subcommand === 'reset') {
          const threadId = interaction.channelId;
          const session = sessionManager.getByThread(threadId);

          if (!session) {
            await interaction.reply({ content: 'No active session in this thread.', ephemeral: true });
            return;
          }

          if (session.userId !== interaction.user.id) {
            await interaction.reply({ content: 'You can only reset your own sessions.', ephemeral: true });
            return;
          }

          const oldMsgCount = session.messages.length;
          session.messages = [];
          import('../../storage/database.js').then(({ deleteClaudeCodeSession }) => {
            deleteClaudeCodeSession(session.id);
          }).catch(() => {});
          aiClient?.clearClaudeCodeSession(session.id);

          const embed = new EmbedBuilder()
            .setColor(BotColors.Success)
            .setTitle('Session Reset')
            .setDescription('Conversation history cleared and CC session restarted.')
            .addFields(
              { name: 'Messages Cleared', value: `${oldMsgCount}`, inline: true },
            )
            .setTimestamp();

          await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (subcommand === 'status') {
          const sessions = sessionManager
            .getActiveSessions()
            .filter((s) => s.userId === interaction.user.id);

          if (sessions.length === 0) {
            const embed = new EmbedBuilder()
              .setColor(BotColors.Neutral)
              .setTitle('Your Sessions')
              .setDescription('No active sessions. Use `/code` to start one.')
              .setTimestamp();

            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
          }

          const embed = new EmbedBuilder()
            .setColor(BotColors.Session)
            .setTitle(`Your Active Sessions (${sessions.length})`)
            .setTimestamp();

          for (const s of sessions.slice(0, 10)) {
            const age = formatDuration(Date.now() - s.createdAt);
            const idle = formatDuration(Date.now() - s.lastActiveAt);
            embed.addFields({
              name: `<#${s.threadId}>`,
              value: `${s.messages.length} messages | Age: ${age} | Idle: ${idle}${s.repoOwner ? ` | Repo: ${s.repoOwner}/${s.repoName}` : ''}`,
            });
          }

          await interaction.reply({ embeds: [embed], ephemeral: true });
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
