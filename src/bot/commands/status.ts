import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { isAllowed } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import { getProviderForModel } from '../../claude/aiClient.js';
import { config } from '../../config.js';
import { BotColors, formatDuration } from '../../utils/embedHelpers.js';
import type { CommandHandler } from './types.js';

function providerLabel(provider: string): string {
  switch (provider) {
    case 'claude-code': return 'Claude Code';
    case 'google': return 'Google';
    case 'ollama': return 'Ollama';
    default: return 'Anthropic';
  }
}

export function createStatusCommand(sessionManager: SessionManager): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show current session info and bot configuration'),

    async execute(interaction: ChatInputCommandInteraction) {
      try {
        if (!isAllowed(interaction.member as GuildMember | null, interaction.user.id)) {
          await interaction.reply({ content: 'You do not have a role that allows using this bot.', ephemeral: true });
          return;
        }

        const session = sessionManager.getByThread(interaction.channelId);
        const defaultModel = config.ANTHROPIC_MODEL;
        const defaultProvider = getProviderForModel(defaultModel);

        const features: string[] = [];
        if (config.ENABLE_DEV_TOOLS) features.push('`dev-tools`');
        if (config.ENABLE_SCRIPT_EXECUTION) features.push('`sandbox`');
        if (config.ENABLE_EXTENDED_THINKING) features.push('`thinking`');
        if (config.ENABLE_WEB_SEARCH) features.push('`web-search`');

        if (session) {
          const effectiveModel = session.modelOverride || defaultModel;
          const provider = getProviderForModel(effectiveModel);
          const thinkingEnabled = session.thinkingEnabled != null ? session.thinkingEnabled : config.ENABLE_EXTENDED_THINKING;
          const thinkingBudget = session.thinkingBudget || config.THINKING_BUDGET_TOKENS;
          const age = Date.now() - session.createdAt;
          const idle = Date.now() - session.lastActiveAt;

          const embed = new EmbedBuilder()
            .setColor(BotColors.Session)
            .setTitle('Session Status')
            .addFields(
              { name: 'Model', value: `\`${effectiveModel}\`\n${providerLabel(provider)}${session.modelOverride ? ' *(override)*' : ''}`, inline: true },
              { name: 'Repo', value: session.repoOwner ? `${session.repoOwner}/${session.repoName}${session.defaultBranch ? ` (\`${session.defaultBranch}\`)` : ''}` : '*none*', inline: true },
              { name: 'Thinking', value: thinkingEnabled ? `On (${thinkingBudget.toLocaleString()} tokens)` : 'Off', inline: true },
              { name: 'Messages', value: `${session.messages.length}`, inline: true },
              { name: 'Age', value: formatDuration(age), inline: true },
              { name: 'Idle', value: formatDuration(idle), inline: true },
            )
            .setFooter({ text: `Session ID: ${session.id}` })
            .setTimestamp();

          if (features.length > 0) {
            embed.addFields({ name: 'Enabled Features', value: features.join(', ') });
          }

          if (session.modelOverride && session.modelOverride !== defaultModel) {
            embed.addFields({ name: 'Global Default', value: `\`${defaultModel}\` (${providerLabel(defaultProvider)})` });
          }

          await interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
          const embed = new EmbedBuilder()
            .setColor(BotColors.Neutral)
            .setTitle('Bot Status')
            .setDescription('No active session in this thread.')
            .addFields(
              { name: 'Default Model', value: `\`${defaultModel}\`\n${providerLabel(defaultProvider)}`, inline: true },
              { name: 'Features', value: features.length > 0 ? features.join(', ') : '*none*', inline: true },
            )
            .setTimestamp();

          await interaction.reply({ embeds: [embed], ephemeral: true });
        }
      } catch (err) {
        await interaction.reply({ content: formatApiError(err), ephemeral: true }).catch(() => {});
      }
    },
  };
}
