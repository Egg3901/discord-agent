import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { isAllowed } from '../middleware/permissions.js';
import { BotColors, successEmbed } from '../../utils/embedHelpers.js';
import type { CommandHandler } from './types.js';

export function createBaseBranchCommand(sessionManager: SessionManager): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('basebranch')
      .setDescription('Set or view the base branch for PRs in this session')
      .addStringOption((opt) =>
        opt
          .setName('branch')
          .setDescription('Base branch name (e.g. "develop", "master", "staging"). Omit to view current.')
          .setRequired(false),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAllowed(interaction.member as GuildMember | null, interaction.user.id)) {
        await interaction.reply({ content: 'You do not have a role that allows using this bot.', ephemeral: true });
        return;
      }

      const session = sessionManager.getByThread(interaction.channelId);
      if (!session) {
        await interaction.reply({ content: 'No active session in this thread.', ephemeral: true });
        return;
      }

      const branch = interaction.options.getString('branch');

      if (!branch) {
        // Show current
        const current = session.defaultBranch || 'main (auto-detected)';
        const embed = new EmbedBuilder()
          .setColor(BotColors.Info)
          .setTitle('Base Branch')
          .setDescription(`Current base branch: **\`${current}\`**`)
          .setFooter({ text: 'Used as the default target for create_pr. Set with /basebranch <name>' })
          .setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      // Validate branch name (no spaces, no special chars)
      if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
        await interaction.reply({ content: 'Invalid branch name. Use alphanumeric characters, `.`, `-`, `_`, or `/`.', ephemeral: true });
        return;
      }

      session.defaultBranch = branch;
      await interaction.reply({
        embeds: [successEmbed(`Base branch set to **\`${branch}\`**`).setFooter({
          text: 'All PRs in this session will target this branch by default',
        })],
        ephemeral: true,
      });
    },
  };
}
