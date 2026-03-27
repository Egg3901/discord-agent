import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
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
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('paths')
          .setDescription('Comma-separated file paths to focus on (optional)')
          .setRequired(false),
      ),

    async autocomplete(interaction: AutocompleteInteraction) {
      const focused = interaction.options.getFocused();
      try {
        const repos = await repoFetcher.listUserRepos(focused || undefined);
        await interaction.respond(
          repos.map((r) => ({
            name: `${r.fullName}${r.isPrivate ? ' 🔒' : ''}${r.description ? ` — ${r.description}` : ''}`.slice(0, 100),
            value: `https://github.com/${r.fullName}`,
          })),
        );
      } catch (err) {
        logger.warn({ err }, 'Repo autocomplete failed');
        await interaction.respond([]);
      }
    },

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

        // Store repo owner/name for tool executor
        session.repoOwner = owner;
        session.repoName = repo;

        if (paths && paths.length > 0) {
          // If specific paths requested, fetch those files
          const files = await repoFetcher.fetchFiles(owner, repo, paths);
          session.repoContext = { repoUrl: url, files };
        } else {
          // With tools available, fetch only tree + README for initial context
          const tree = await repoFetcher.getTree(owner, repo);
          const readmeFiles = await repoFetcher.fetchFiles(owner, repo, ['README.md', 'readme.md']);
          session.repoContext = {
            repoUrl: url,
            files: [
              { path: '[TREE]', content: tree.join('\n') },
              ...readmeFiles,
            ],
          };
        }

        const fileList = session.repoContext.files.map((f) => `• \`${f.path}\``).join('\n');
        await interaction.editReply(
          `Repository context loaded from **${owner}/${repo}**:\n${fileList}\n\nAgent mode enabled — the AI can now read files, list directories, and search code in the repo.`,
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
