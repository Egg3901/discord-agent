import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { sandboxListFiles, getSandboxDir } from '../../tools/scriptExecutor.js';
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
        const msg = err instanceof Error ? err.message : String(err);
        await interaction.editReply(`Error reading sandbox: ${msg}`);
      }
    },
  };
}
