import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { isAdmin, addAllowedRole, removeAllowedRole, listAllowedRoles } from '../middleware/permissions.js';
import { KeyPool } from '../../keys/keyPool.js';
import { SessionManager } from '../../sessions/sessionManager.js';
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
            opt.setName('key').setDescription('Anthropic API key').setRequired(true),
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

      if (subcommand === 'addkey') {
        const apiKey = interaction.options.getString('key', true);
        const id = keyPool.addKey(apiKey, interaction.user.id);
        await interaction.reply({
          content: `Key added with ID: \`${id}\`. It's now available for use.`,
          ephemeral: true,
        });
      }

      if (subcommand === 'removekey') {
        const id = interaction.options.getString('id', true);
        const removed = keyPool.removeKey(id);
        await interaction.reply({
          content: removed ? `Key \`${id}\` removed.` : `Key \`${id}\` not found.`,
          ephemeral: true,
        });
      }

      if (subcommand === 'keys') {
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
          return `${status} \`${k.id}\` — \`${masked}\` — ${k.totalRequests} total, ${k.requestsThisMinute}/min`;
        });

        await interaction.reply({
          content: `**API Keys (${keys.length}):**\n${lines.join('\n')}`,
          ephemeral: true,
        });
      }

      if (subcommand === 'stats') {
        const poolStats = keyPool.getStats();
        const sessions = sessionManager.getActiveSessions();

        const msg = [
          '**Bot Statistics:**',
          `Keys: ${poolStats.healthy} healthy / ${poolStats.degraded} degraded / ${poolStats.dead} dead (${poolStats.total} total)`,
          `Queue depth: ${poolStats.queueDepth}`,
          `Requests/min: ${poolStats.requestsThisMinute}`,
          `Active sessions: ${sessions.length}`,
          `Unique users: ${new Set(sessions.map((s) => s.userId)).size}`,
        ];

        await interaction.reply({ content: msg.join('\n'), ephemeral: true });
      }

      if (subcommand === 'prune') {
        const pruned = sessionManager.pruneStale();
        await interaction.reply({
          content: `Pruned ${pruned} stale session(s).`,
          ephemeral: true,
        });
      }

      if (subcommand === 'allowrole') {
        const role = interaction.options.getRole('role', true);
        addAllowedRole(role.id, role.name);
        await interaction.reply({
          content: `Role **${role.name}** added. Only users with allowed roles (or admins) can now use the bot.`,
          ephemeral: true,
        });
      }

      if (subcommand === 'denyrole') {
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
      }

      if (subcommand === 'roles') {
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
      }
    },
  };
}
