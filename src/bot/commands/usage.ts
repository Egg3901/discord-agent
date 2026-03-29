import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { isAllowed, isAdmin } from '../middleware/permissions.js';
import { getUsageSummary } from '../../storage/database.js';
import { BotColors, formatTokens, formatCost } from '../../utils/embedHelpers.js';
import type { CommandHandler } from './types.js';

export function createUsageCommand(): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('usage')
      .setDescription('View your token usage and costs')
      .addStringOption((opt) =>
        opt
          .setName('period')
          .setDescription('Time period (default: 30 days)')
          .setRequired(false)
          .addChoices(
            { name: 'Today', value: '1' },
            { name: 'Last 7 days', value: '7' },
            { name: 'Last 30 days', value: '30' },
            { name: 'All time', value: '3650' },
          ),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('all')
          .setDescription('Show all users (admin only)')
          .setRequired(false),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAllowed(interaction.member as GuildMember | null, interaction.user.id)) {
        await interaction.reply({
          content: 'You do not have a role that allows using this bot.',
          ephemeral: true,
        });
        return;
      }

      const days = parseInt(interaction.options.getString('period') || '30', 10);
      const showAll = interaction.options.getBoolean('all') || false;

      const userId = showAll && isAdmin(interaction.member as GuildMember | null)
        ? undefined
        : interaction.user.id;

      const summary = getUsageSummary(userId, days);
      const periodLabel = days >= 3650 ? 'All Time' : `Last ${days} Day${days !== 1 ? 's' : ''}`;
      const scope = userId ? 'Your' : 'All Users\'';

      if (summary.totalRequests === 0) {
        const embed = new EmbedBuilder()
          .setColor(BotColors.Neutral)
          .setTitle(`${scope} Usage — ${periodLabel}`)
          .setDescription('No usage recorded for this period.')
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(BotColors.Info)
        .setTitle(`${scope} Usage — ${periodLabel}`)
        .addFields(
          { name: 'Requests', value: summary.totalRequests.toLocaleString(), inline: true },
          { name: 'Tokens In', value: formatTokens(summary.totalTokensIn), inline: true },
          { name: 'Tokens Out', value: formatTokens(summary.totalTokensOut), inline: true },
        )
        .setTimestamp();

      if (summary.totalCostUsd > 0) {
        embed.addFields({ name: 'Estimated Cost', value: formatCost(summary.totalCostUsd), inline: true });
      }

      // Per-model breakdown
      const modelEntries = Object.entries(summary.models);
      if (modelEntries.length > 0) {
        const modelLines = modelEntries.map(
          ([model, stats]) =>
            `\`${model}\` — ${stats.requests} req, ${formatTokens(stats.tokensIn)} in / ${formatTokens(stats.tokensOut)} out`,
        );
        embed.addFields({ name: 'By Model', value: modelLines.join('\n') });
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
    },
  };
}
