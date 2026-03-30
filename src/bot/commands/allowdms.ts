import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { isAdmin } from '../middleware/permissions.js';
import {
  addDmAllowlistUser,
  removeDmAllowlistUser,
  listDmAllowlistUsers,
} from '../../storage/database.js';
import type { CommandHandler } from './types.js';

export function createAllowDmsCommand(): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('allowdms')
      .setDescription('Manage the DM allowlist (admin only)')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Allow a user to interact with the bot via DMs')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to allow').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a user from the DM allowlist')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to remove').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('List all users on the DM allowlist'),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAdmin(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'You need **Administrator** permission to manage the DM allowlist.',
          ephemeral: true,
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      switch (subcommand) {
        case 'add': {
          const user = interaction.options.getUser('user', true);
          addDmAllowlistUser(user.id, interaction.user.id);
          await interaction.reply({
            content: `**${user.tag}** (\`${user.id}\`) can now use the bot via DMs.`,
            ephemeral: true,
          });
          break;
        }

        case 'remove': {
          const user = interaction.options.getUser('user', true);
          const removed = removeDmAllowlistUser(user.id);
          await interaction.reply({
            content: removed
              ? `**${user.tag}** removed from the DM allowlist.`
              : `**${user.tag}** was not on the DM allowlist.`,
            ephemeral: true,
          });
          break;
        }

        case 'list': {
          const users = listDmAllowlistUsers();
          if (users.length === 0) {
            await interaction.reply({
              content: 'No users on the DM allowlist. Use `/allowdms add @user` to add one.',
              ephemeral: true,
            });
            return;
          }

          const lines = users.map(
            (u) => `• <@${u.user_id}> — added by <@${u.added_by}> (<t:${Math.floor(u.added_at / 1000)}:R>)`,
          );
          await interaction.reply({
            content: `**DM Allowlist (${users.length}):**\n${lines.join('\n')}`,
            ephemeral: true,
          });
          break;
        }
      }
    },
  };
}
