import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { isAdmin, addAllowedRole, removeAllowedRole, listAllowedRoles } from '../middleware/permissions.js';
import { KeyPool } from '../../keys/keyPool.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { getUsageSummary } from '../../storage/database.js';
import { Octokit } from '@octokit/rest';
import { config } from '../../config.js';
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
            content: `Key added with ID: \`${id}\` for **${providerLabel}**. It's now available for use.`,
            ephemeral: true,
          });
          break;
        }

        case 'removekey': {
          const id = interaction.options.getString('id', true);
          const removed = keyPool.removeKey(id);
          await interaction.reply({
            content: removed ? `Key \`${id}\` removed.` : `Key \`${id}\` not found.`,
            ephemeral: true,
          });
          break;
        }

        case 'keys': {
          const keys = keyPool.getKeys();
          if (keys.length === 0) {
            await interaction.reply({
              content: 'No API keys configured. Add one with `/admin addkey`.',
              ephemeral: true,
            });
            return;
          }

          const lines = keys.map((k) => {
            const masked = k.apiKey.slice(0, 10) + '...' + k.apiKey.slice(-4);
            const status =
              k.status === 'healthy' ? '🟢' : k.status === 'degraded' ? '🟡' : '🔴';
            const prov = k.provider === 'google' ? 'Gemini' : 'Claude';
            return `${status} \`${k.id}\` [${prov}] — \`${masked}\` — ${k.totalRequests} total, ${k.requestsThisMinute}/min`;
          });

          await interaction.reply({
            content: `**API Keys (${keys.length}):**\n${lines.join('\n')}`,
            ephemeral: true,
          });
          break;
        }

        case 'stats': {
          const poolStats = keyPool.getStats();
          const sessions = sessionManager.getActiveSessions();
          const todayUsage = getUsageSummary(undefined, 1);
          const weekUsage = getUsageSummary(undefined, 7);

          const msg = [
            '**Bot Statistics:**',
            '',
            '**Key Pool:**',
            `Keys: ${poolStats.healthy} healthy / ${poolStats.degraded} degraded / ${poolStats.dead} dead (${poolStats.total} total)`,
            `Queue depth: ${poolStats.queueDepth}`,
            `Requests/min: ${poolStats.requestsThisMinute}`,
            '',
            '**Sessions:**',
            `Active: ${sessions.length}`,
            `Unique users: ${new Set(sessions.map((s) => s.userId)).size}`,
            '',
            '**Usage — Today:**',
            `${todayUsage.totalRequests} requests, ${todayUsage.totalTokensIn.toLocaleString()} tokens in / ${todayUsage.totalTokensOut.toLocaleString()} out${todayUsage.totalCostUsd > 0 ? ` ($${todayUsage.totalCostUsd.toFixed(4)})` : ''}`,
            '',
            '**Usage — Last 7 days:**',
            `${weekUsage.totalRequests} requests, ${weekUsage.totalTokensIn.toLocaleString()} tokens in / ${weekUsage.totalTokensOut.toLocaleString()} out${weekUsage.totalCostUsd > 0 ? ` ($${weekUsage.totalCostUsd.toFixed(4)})` : ''}`,
          ];

          // Per-model breakdown for the week
          const modelEntries = Object.entries(weekUsage.models);
          if (modelEntries.length > 0) {
            msg.push('', '**By model (7d):**');
            for (const [model, stats] of modelEntries) {
              msg.push(`> \`${model}\` — ${stats.requests} req, ${stats.tokensIn.toLocaleString()} in / ${stats.tokensOut.toLocaleString()} out`);
            }
          }

          await interaction.reply({ content: msg.join('\n'), ephemeral: true });
          break;
        }

        case 'prune': {
          const pruned = sessionManager.pruneStale();
          await interaction.reply({
            content: `Pruned ${pruned} stale session(s).`,
            ephemeral: true,
          });
          break;
        }

        case 'allowrole': {
          const role = interaction.options.getRole('role', true);
          addAllowedRole(role.id, role.name);
          await interaction.reply({
            content: `Role **${role.name}** added. Only users with allowed roles (or admins) can now use the bot.`,
            ephemeral: true,
          });
          break;
        }

        case 'denyrole': {
          const role = interaction.options.getRole('role', true);
          const removed = removeAllowedRole(role.id);
          const roles = listAllowedRoles();
          const note = roles.length === 0
            ? ' No roles remain — the bot is now open to everyone.'
            : '';
          await interaction.reply({
            content: removed
              ? `Role **${role.name}** removed.${note}`
              : `Role **${role.name}** was not in the allowed list.`,
            ephemeral: true,
          });
          break;
        }

        case 'setgittoken': {
          const token = interaction.options.getString('token', true);
          config.set('GITHUB_TOKEN', token);
          const masked = token.slice(0, 6) + '...' + token.slice(-4);
          await interaction.reply({
            content: `GitHub token set: \`${masked}\`. It will be used for all future repo fetches.`,
            ephemeral: true,
          });
          break;
        }

        case 'verifygittoken': {
          if (!config.GITHUB_TOKEN) {
            await interaction.reply({
              content: '**GitHub Token:** Not set.\nUse `/admin setgittoken` or set the `GITHUB_TOKEN` environment variable.',
              ephemeral: true,
            });
            return;
          }

          const masked = config.GITHUB_TOKEN.slice(0, 6) + '...' + config.GITHUB_TOKEN.slice(-4);
          await interaction.deferReply({ ephemeral: true });

          try {
            const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 10_000 } });
            const { data: user } = await octokit.users.getAuthenticated();
            const scopes = (await octokit.request('GET /user')).headers['x-oauth-scopes'] || 'unknown';
            await interaction.editReply(
              `**GitHub Token:** Valid\n` +
              `**User:** ${user.login}\n` +
              `**Token:** \`${masked}\`\n` +
              `**Scopes:** \`${scopes}\``,
            );
          } catch (err: any) {
            const status = err.status || 'unknown';
            const msg = err.message || 'Unknown error';
            await interaction.editReply(
              `**GitHub Token:** Invalid\n` +
              `**Token:** \`${masked}\`\n` +
              `**Error:** ${status} — ${msg}`,
            );
          }
          break;
        }

        case 'roles': {
          const roles = listAllowedRoles();
          if (roles.length === 0) {
            await interaction.reply({
              content: 'No role restrictions — everyone can use the bot.\nUse `/admin allowrole @role` to restrict access.',
              ephemeral: true,
            });
            return;
          }

          const lines = roles.map((r) => `• <@&${r.role_id}> (\`${r.role_name}\`)`);
          await interaction.reply({
            content: `**Allowed roles (${roles.length}):**\n${lines.join('\n')}\n\nAdmins always have access. Use \`/admin denyrole @role\` to remove.`,
            ephemeral: true,
          });
          break;
        }
      }
    },
  };
}
