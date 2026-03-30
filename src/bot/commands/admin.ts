import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { isAdmin, addAllowedRole, removeAllowedRole, listAllowedRoles } from '../middleware/permissions.js';
import { KeyPool } from '../../keys/keyPool.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { getUsageSummary } from '../../storage/database.js';
import { Octokit } from '@octokit/rest';
import { config } from '../../config.js';
import { BotColors, formatTokens, formatCost, successEmbed } from '../../utils/embedHelpers.js';
import type { CommandHandler } from './types.js';

export function createAdminCommand(
  keyPool: KeyPool,
  sessionManager: SessionManager,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('admin')
      .setDescription('Admin commands for managing the bot')
      .addSubcommand((sub) =>
        sub
          .setName('addkey')
          .setDescription('Add an API key to the pool')
          .addStringOption((opt) =>
            opt.setName('key').setDescription('API key').setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('provider')
              .setDescription('API provider (default: anthropic)')
              .setRequired(false)
              .addChoices(
                { name: 'Anthropic (Claude)', value: 'anthropic' },
                { name: 'Google (Gemini)', value: 'google' },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('removekey')
          .setDescription('Remove an API key from the pool')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('Key ID to remove').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('keys').setDescription('List all API keys and their status'),
      )
      .addSubcommand((sub) =>
        sub.setName('stats').setDescription('View bot statistics'),
      )
      .addSubcommand((sub) =>
        sub.setName('prune').setDescription('Force-prune stale sessions'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('allowrole')
          .setDescription('Allow a role to use the bot (restricts access when set)')
          .addRoleOption((opt) =>
            opt.setName('role').setDescription('Role to allow').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('denyrole')
          .setDescription('Remove a role from the allowed list')
          .addRoleOption((opt) =>
            opt.setName('role').setDescription('Role to remove').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('roles').setDescription('List allowed roles (empty = everyone)'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('setgittoken')
          .setDescription('Set the GitHub token for private repo access')
          .addStringOption((opt) =>
            opt.setName('token').setDescription('GitHub personal access token (ghp_...)').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('verifygittoken').setDescription('Check if the GitHub token is set and valid'),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAdmin(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'You do not have permission to use this command.',
          ephemeral: true,
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      switch (subcommand) {
        case 'addkey': {
          const apiKey = interaction.options.getString('key', true);
          const provider = (interaction.options.getString('provider') || 'anthropic') as 'anthropic' | 'google';
          const id = keyPool.addKey(apiKey, provider, interaction.user.id);
          const providerLabel = provider === 'google' ? 'Google (Gemini)' : 'Anthropic (Claude)';

          await interaction.reply({
            embeds: [successEmbed(`Key added for **${providerLabel}**`).addFields(
              { name: 'Key ID', value: `\`${id}\``, inline: true },
              { name: 'Status', value: 'Available for use', inline: true },
            )],
            ephemeral: true,
          });
          break;
        }

        case 'removekey': {
          const id = interaction.options.getString('id', true);
          const removed = keyPool.removeKey(id);
          await interaction.reply({
            embeds: [removed
              ? successEmbed(`Key \`${id}\` removed.`)
              : new EmbedBuilder().setColor(BotColors.Warning).setDescription(`Key \`${id}\` not found.`)],
            ephemeral: true,
          });
          break;
        }

        case 'keys': {
          const keys = keyPool.getKeys();
          if (keys.length === 0) {
            const embed = new EmbedBuilder()
              .setColor(BotColors.Neutral)
              .setTitle('API Keys')
              .setDescription('No API keys configured. Add one with `/admin addkey`.')
              .setTimestamp();
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
          }

          const embed = new EmbedBuilder()
            .setColor(BotColors.Admin)
            .setTitle(`API Keys (${keys.length})`)
            .setTimestamp();

          for (const k of keys.slice(0, 25)) {
            const masked = k.apiKey.slice(0, 10) + '...' + k.apiKey.slice(-4);
            const status =
              k.status === 'healthy' ? '🟢 Healthy' : k.status === 'degraded' ? '🟡 Degraded' : '🔴 Dead';
            const prov = k.provider === 'google' ? 'Gemini' : 'Claude';
            embed.addFields({
              name: `\`${k.id}\` [${prov}]`,
              value: `${status} | \`${masked}\`\n${k.totalRequests} total, ${k.requestsThisMinute}/min`,
              inline: true,
            });
          }

          await interaction.reply({ embeds: [embed], ephemeral: true });
          break;
        }

        case 'stats': {
          const poolStats = keyPool.getStats();
          const sessions = sessionManager.getActiveSessions();
          const todayUsage = getUsageSummary(undefined, 1);
          const weekUsage = getUsageSummary(undefined, 7);

          const embed = new EmbedBuilder()
            .setColor(BotColors.Admin)
            .setTitle('Bot Statistics')
            .addFields(
              { name: 'Key Pool', value: [
                `🟢 ${poolStats.healthy} healthy`,
                `🟡 ${poolStats.degraded} degraded`,
                `🔴 ${poolStats.dead} dead`,
                `📊 ${poolStats.total} total`,
                `⏳ Queue: ${poolStats.queueDepth}`,
                `⚡ ${poolStats.requestsThisMinute}/min`,
              ].join('\n'), inline: true },
              { name: 'Sessions', value: [
                `Active: **${sessions.length}**`,
                `Users: **${new Set(sessions.map((s) => s.userId)).size}**`,
              ].join('\n'), inline: true },
            )
            .addFields(
              { name: 'Usage — Today', value: [
                `${todayUsage.totalRequests} requests`,
                `${formatTokens(todayUsage.totalTokensIn)} in / ${formatTokens(todayUsage.totalTokensOut)} out`,
                todayUsage.totalCostUsd > 0 ? formatCost(todayUsage.totalCostUsd) : '',
              ].filter(Boolean).join('\n'), inline: true },
              { name: 'Usage — 7 Days', value: [
                `${weekUsage.totalRequests} requests`,
                `${formatTokens(weekUsage.totalTokensIn)} in / ${formatTokens(weekUsage.totalTokensOut)} out`,
                weekUsage.totalCostUsd > 0 ? formatCost(weekUsage.totalCostUsd) : '',
              ].filter(Boolean).join('\n'), inline: true },
            )
            .setTimestamp();

          // Per-model breakdown
          const modelEntries = Object.entries(weekUsage.models);
          if (modelEntries.length > 0) {
            const modelLines = modelEntries.map(
              ([model, stats]) =>
                `\`${model}\` — ${stats.requests} req, ${formatTokens(stats.tokensIn)} in / ${formatTokens(stats.tokensOut)} out`,
            );
            embed.addFields({ name: 'By Model (7d)', value: modelLines.join('\n') });
          }

          await interaction.reply({ embeds: [embed], ephemeral: true });
          break;
        }

        case 'prune': {
          const pruned = sessionManager.pruneStale();
          await interaction.reply({
            embeds: [successEmbed(`Pruned **${pruned}** stale session(s).`)],
            ephemeral: true,
          });
          break;
        }

        case 'allowrole': {
          const role = interaction.options.getRole('role', true);
          addAllowedRole(role.id, role.name);
          await interaction.reply({
            embeds: [successEmbed(`Role **${role.name}** added.`).setDescription(
              `Role **${role.name}** added. Only users with allowed roles (or admins) can now use the bot.`,
            )],
            ephemeral: true,
          });
          break;
        }

        case 'denyrole': {
          const role = interaction.options.getRole('role', true);
          const removed = removeAllowedRole(role.id);
          const roles = listAllowedRoles();
          const note = roles.length === 0
            ? '\nNo roles remain — the bot is now open to everyone.'
            : '';

          await interaction.reply({
            embeds: [removed
              ? successEmbed(`Role **${role.name}** removed.${note}`)
              : new EmbedBuilder().setColor(BotColors.Warning).setDescription(`Role **${role.name}** was not in the allowed list.`)],
            ephemeral: true,
          });
          break;
        }

        case 'setgittoken': {
          const token = interaction.options.getString('token', true);
          config.set('GITHUB_TOKEN', token);
          const masked = token.slice(0, 6) + '...' + token.slice(-4);
          await interaction.reply({
            embeds: [successEmbed(`GitHub token set: \`${masked}\``).addFields(
              { name: 'Scope', value: 'All future repo fetches', inline: true },
            )],
            ephemeral: true,
          });
          break;
        }

        case 'verifygittoken': {
          if (!config.GITHUB_TOKEN) {
            const embed = new EmbedBuilder()
              .setColor(BotColors.Warning)
              .setTitle('GitHub Token')
              .setDescription('Not set. Use `/admin setgittoken` or set the `GITHUB_TOKEN` environment variable.')
              .setTimestamp();
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
          }

          const masked = config.GITHUB_TOKEN.slice(0, 6) + '...' + config.GITHUB_TOKEN.slice(-4);
          await interaction.deferReply({ ephemeral: true });

          try {
            const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 10_000 } });
            const { data: user } = await octokit.users.getAuthenticated();
            const scopes = (await octokit.request('GET /user')).headers['x-oauth-scopes'] || 'unknown';

            const embed = new EmbedBuilder()
              .setColor(BotColors.Success)
              .setTitle('GitHub Token — Valid')
              .addFields(
                { name: 'User', value: user.login, inline: true },
                { name: 'Token', value: `\`${masked}\``, inline: true },
                { name: 'Scopes', value: `\`${scopes}\``, inline: false },
              )
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
          } catch (err: any) {
            const status = err.status || 'unknown';
            const msg = err.message || 'Unknown error';
            const embed = new EmbedBuilder()
              .setColor(BotColors.Error)
              .setTitle('GitHub Token — Invalid')
              .addFields(
                { name: 'Token', value: `\`${masked}\``, inline: true },
                { name: 'Error', value: `${status} — ${msg}`, inline: false },
              )
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
          }
          break;
        }

        case 'roles': {
          const roles = listAllowedRoles();
          if (roles.length === 0) {
            const embed = new EmbedBuilder()
              .setColor(BotColors.Neutral)
              .setTitle('Allowed Roles')
              .setDescription('No role restrictions — everyone can use the bot.\nUse `/admin allowrole @role` to restrict access.')
              .setTimestamp();
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
          }

          const embed = new EmbedBuilder()
            .setColor(BotColors.Admin)
            .setTitle(`Allowed Roles (${roles.length})`)
            .setDescription(
              roles.map((r) => `<@&${r.role_id}> (\`${r.role_name}\`)`).join('\n') +
              '\n\nAdmins always have access. Use `/admin denyrole @role` to remove.',
            )
            .setTimestamp();

          await interaction.reply({ embeds: [embed], ephemeral: true });
          break;
        }
      }
    },
  };
}
