import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { isAdmin } from '../middleware/permissions.js';
import { listToolMetrics, resetToolMetrics } from '../../tools/toolMetrics.js';
import { BotColors } from '../../utils/embedHelpers.js';
import type { CommandHandler } from './types.js';

export function createToolStatsCommand(): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('toolstats')
      .setDescription('View per-tool invocation stats (calls, errors, avg duration)')
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('What to do')
          .setRequired(false)
          .addChoices(
            { name: 'View stats (default)', value: 'view' },
            { name: 'Reset all stats', value: 'reset' },
            { name: 'View errors only', value: 'errors' },
          ),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('min_calls')
          .setDescription('Hide tools called fewer than N times (default: 1)')
          .setRequired(false)
          .setMinValue(0),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAdmin(interaction.member as GuildMember | null)) {
        await interaction.reply({ content: 'This command requires administrator permissions.', ephemeral: true });
        return;
      }

      const action = interaction.options.getString('action') || 'view';
      const minCalls = interaction.options.getInteger('min_calls') ?? 1;

      if (action === 'reset') {
        const removed = resetToolMetrics();
        await interaction.reply({
          content: `Cleared tool metrics (${removed} row${removed === 1 ? '' : 's'}).`,
          ephemeral: true,
        });
        return;
      }

      const rows = listToolMetrics({ minCalls });
      if (rows.length === 0) {
        await interaction.reply({
          content: `No tool metrics recorded yet (min_calls=${minCalls}).`,
          ephemeral: true,
        });
        return;
      }

      const filtered = action === 'errors' ? rows.filter((r) => r.error_count > 0) : rows;
      if (filtered.length === 0) {
        await interaction.reply({ content: 'No tools have recorded errors yet.', ephemeral: true });
        return;
      }

      // Build a compact table in monospaced code block so it renders cleanly on mobile.
      const header = 'tool                       calls   err   empty   avg ms';
      const lines = filtered.slice(0, 25).map((r) => {
        const name = r.tool_name.padEnd(26).slice(0, 26);
        const calls = String(r.total_count).padStart(6);
        const err = String(r.error_count).padStart(5);
        const empty = String(r.empty_count).padStart(7);
        const avg = r.total_count > 0
          ? Math.round(r.total_duration_ms / r.total_count).toString().padStart(8)
          : '       —';
        return `${name} ${calls} ${err} ${empty} ${avg}`;
      });
      const table = '```\n' + header + '\n' + lines.join('\n') + '\n```';

      const totals = filtered.reduce(
        (acc, r) => ({
          calls: acc.calls + r.total_count,
          errors: acc.errors + r.error_count,
          empty: acc.empty + r.empty_count,
        }),
        { calls: 0, errors: 0, empty: 0 },
      );
      const errorRate = totals.calls > 0 ? ((totals.errors / totals.calls) * 100).toFixed(1) : '0.0';
      const emptyRate = totals.calls > 0 ? ((totals.empty / totals.calls) * 100).toFixed(1) : '0.0';

      const embed = new EmbedBuilder()
        .setColor(totals.errors > 0 ? BotColors.Warning : BotColors.Info)
        .setTitle(`Tool Stats${action === 'errors' ? ' — errors only' : ''}`)
        .setDescription(table)
        .addFields(
          { name: 'Total calls', value: totals.calls.toLocaleString(), inline: true },
          { name: 'Errors', value: `${totals.errors} (${errorRate}%)`, inline: true },
          { name: 'Empty results', value: `${totals.empty} (${emptyRate}%)`, inline: true },
        )
        .setFooter({ text: 'Empty = "no results" / "no matches" / not found. Use /toolstats action:reset to clear.' })
        .setTimestamp();

      // Surface the most recent error from any tool that has one, to save
      // an admin the hop to the logs when something is obviously broken.
      const mostRecentErr = filtered
        .filter((r) => r.last_error && r.last_error_at)
        .sort((a, b) => (b.last_error_at || 0) - (a.last_error_at || 0))[0];
      if (mostRecentErr?.last_error) {
        const ts = mostRecentErr.last_error_at
          ? `<t:${Math.floor(mostRecentErr.last_error_at / 1000)}:R>`
          : '';
        embed.addFields({
          name: `Latest error: ${mostRecentErr.tool_name} ${ts}`,
          value: '```\n' + mostRecentErr.last_error.slice(0, 800) + '\n```',
        });
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
    },
  };
}
