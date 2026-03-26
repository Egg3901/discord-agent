import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';

export function createRepoCommand(
  sessionManager: SessionManager,
  repoFetcher: RepoFetcher,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('repo')
      .setDescription('Attach a GitHub repository as context to the current session')
      .addStringOption((opt) =>
        opt
          .setName('url')
          .setDescription('GitHub repository URL (e.g. https://github.com/owner/repo)')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('paths')
          .setDescription('Comma-separated file paths to focus on (optional)')
          .setRequired(false),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      const threadId = interaction.channelId;
      const session = sessionManager.getByThread(threadId);

      if (!session) {
        await interaction.reply({
          content: 'No active session in this thread. Start one with `/code` first.',
          ephemeral: true,
        });
        return;
      }

      const url = interaction.options.getString('url', true);
      const pathsStr = interaction.options.getString('paths');
      const paths = pathsStr
        ? pathsStr.split(',').map((p) => p.trim())
        : undefined;

      await interaction.deferReply();

      try {
        const { owner, repo } = repoFetcher.parseGitHubUrl(url);
        const files = await repoFetcher.fetchFiles(owner, repo, paths);

        session.repoContext = {
          repoUrl: url,
          files,
        };

        const fileList = files.map((f) => `• \`${f.path}\``).join('\n');
        await interaction.editReply(
          `Repository context loaded from **${owner}/${repo}**:\n${fileList}\n\nFuture messages in this session will use this context.`,
        );
      } catch (err) {
        logger.error({ err }, 'Error fetching repo');
        await interaction.editReply(
          'Failed to fetch repository. Make sure the URL is valid and the repo is accessible.',
        );
      }
    },
  };
}
