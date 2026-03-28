import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { sandboxListFiles, getSandboxDir } from '../../tools/scriptExecutor.js';
import { isAllowed } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import type { CommandHandler } from './types.js';

export function createSandboxCommand(sessionManager: SessionManager): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('sandbox')
      .setDescription('List files in the current session sandbox workspace')
      .addStringOption((opt) =>
        opt
          .setName('path')
          .setDescription('Subdirectory path (default: root)')
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

      const threadId = interaction.channelId;
      const session = sessionManager.getByThread(threadId);

      if (!session) {
        await interaction.reply({
          content: 'No active session in this thread. Use `/code` to start one.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const subpath = interaction.options.getString('path') || '';

      try {
        const sandboxDir = await getSandboxDir(session.id);
        const listing = await sandboxListFiles(subpath, sandboxDir);
        const displayPath = subpath || '/';
        await interaction.editReply(
          `**Sandbox workspace** \`${displayPath}\`:\n\`\`\`\n${listing}\n\`\`\`\n*Sandbox dir: \`${sandboxDir}\`*`,
        );
      } catch (err) {
        const msg = formatApiError(err);
        if (interaction.deferred) {
          await interaction.editReply(msg).catch(() => {});
        } else {
          await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        }
      }
    },
  };
}
