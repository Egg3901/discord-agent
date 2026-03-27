import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { isAllowed } from '../middleware/permissions.js';
import { isAdmin } from '../middleware/permissions.js';
import { getUsageSummary } from '../../storage/database.js';
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
      if (!isAllowed(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'You do not have a role that allows using this bot.',
          ephemeral: true,
        });
        return;
      }

      const days = parseInt(interaction.options.getString('period') || '30', 10);
      const showAll = interaction.options.getBoolean('all') || false;

      // Only admins can see all-user usage
      const userId = showAll && isAdmin(interaction.member as GuildMember | null)
        ? undefined
        : interaction.user.id;

      const summary = getUsageSummary(userId, days);

      if (summary.totalRequests === 0) {
        const periodLabel = days >= 3650 ? 'ever' : `in the last ${days} day(s)`;
        await interaction.reply({
          content: `No usage recorded ${periodLabel}. Usage tracking starts from when this feature was deployed.`,
          ephemeral: true,
        });
        return;
      }

      const periodLabel = days >= 3650 ? 'All time' : `Last ${days} day(s)`;
      const scope = userId ? 'Your' : 'All users\'';

      const lines = [
        `**${scope} Usage — ${periodLabel}:**`,
        '',
        `Requests: **${summary.totalRequests.toLocaleString()}**`,
        `Tokens in: **${summary.totalTokensIn.toLocaleString()}**`,
        `Tokens out: **${summary.totalTokensOut.toLocaleString()}**`,
      ];

      if (summary.totalCostUsd > 0) {
        lines.push(`Estimated cost: **$${summary.totalCostUsd.toFixed(4)}**`);
      }

      // Per-model breakdown
      const modelEntries = Object.entries(summary.models);
      if (modelEntries.length > 0) {
        lines.push('', '**By model:**');
        for (const [model, stats] of modelEntries) {
          lines.push(
            `> \`${model}\` — ${stats.requests} req, ${stats.tokensIn.toLocaleString()} in / ${stats.tokensOut.toLocaleString()} out`,
          );
        }
      }

      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
    },
  };
}
