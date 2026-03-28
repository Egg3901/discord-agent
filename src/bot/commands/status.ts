import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { isAllowed } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import { getProviderForModel } from '../../claude/aiClient.js';
import { config } from '../../config.js';
import type { CommandHandler } from './types.js';

export function createStatusCommand(sessionManager: SessionManager): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show current session info in this thread'),

    async execute(interaction: ChatInputCommandInteraction) {
      try {
        if (!isAllowed(interaction.member as GuildMember | null)) {
          await interaction.reply({ content: 'You do not have a role that allows using this bot.', ephemeral: true });
          return;
        }

        const session = sessionManager.getByThread(interaction.channelId);
        if (!session) {
          await interaction.reply({ content: 'No active session in this thread.', ephemeral: true });
          return;
        }

        const effectiveModel = session.modelOverride || config.ANTHROPIC_MODEL;
        const provider = getProviderForModel(effectiveModel);
        const providerLabel = provider === 'claude-code' ? 'Claude Code' : provider === 'google' ? 'Google' : 'Anthropic';

        const thinkingEnabled = session.thinkingEnabled != null ? session.thinkingEnabled : config.ENABLE_EXTENDED_THINKING;
        const thinkingBudget = session.thinkingBudget || config.THINKING_BUDGET_TOKENS;

        const age = Math.round((Date.now() - session.createdAt) / 60000);
        const idle = Math.round((Date.now() - session.lastActiveAt) / 60000);

        const lines = [
          `**Session Status**`,
          ``,
          `**Model:** \`${effectiveModel}\` (${providerLabel})`,
          session.repoOwner ? `**Repo:** ${session.repoOwner}/${session.repoName}` : '**Repo:** none',
          `**Thinking:** ${thinkingEnabled ? `on (${thinkingBudget} tokens)` : 'off'}`,
          `**Messages:** ${session.messages.length}`,
          `**Age:** ${age}m (idle ${idle}m)`,
          `**Session ID:** \`${session.id}\``,
        ];

        await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      } catch (err) {
        await interaction.reply({ content: formatApiError(err), ephemeral: true }).catch(() => {});
      }
    },
  };
}
