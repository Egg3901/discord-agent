import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { AIClient } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { isAllowed } from '../middleware/permissions.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { formatApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';
import type { GuildMember } from 'discord.js';

export function createReviewCommand(
  aiClient: AIClient,
  rateLimiter: RateLimiter,
  repoFetcher: RepoFetcher,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('review')
      .setDescription('Review a GitHub pull request')
      .addStringOption((opt) =>
        opt
          .setName('pr')
          .setDescription('GitHub PR URL (e.g. https://github.com/owner/repo/pull/123) or owner/repo#123')
          .setRequired(true),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAllowed(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'You do not have a role that allows using this bot.',
          ephemeral: true,
        });
        return;
      }

      if (!rateLimiter.check(interaction.user.id)) {
        await interaction.reply({
          content: 'Rate limit exceeded. Please wait a moment.',
          ephemeral: true,
        });
        return;
      }

      const prInput = interaction.options.getString('pr', true);

      await interaction.deferReply();

      try {
        const parsed = parsePRInput(prInput);
        if (!parsed) {
          await interaction.editReply(
            'Invalid PR format. Use a GitHub URL like `https://github.com/owner/repo/pull/123` or `owner/repo#123`.',
          );
          return;
        }

        const { owner, repo, prNumber } = parsed;

        // Fetch PR details
        let prContext: string;
        try {
          prContext = await repoFetcher.fetchPR(owner, repo, prNumber);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await interaction.editReply(`Failed to fetch PR: ${msg}`);
          return;
        }

        const channel = interaction.channel as TextChannel | ThreadChannel;
        const thinkingMsg = await interaction.editReply('Reviewing PR...');

        // Use the interaction's reply as the thinking message anchor
        const streamer = new ResponseStreamer(channel, thinkingMsg as any);

        const reviewPrompt = `You are doing a code review for PR #${prNumber} in ${owner}/${repo}.

${prContext}

Provide a thorough, actionable code review covering:
1. **Summary** — what does this PR do?
2. **Correctness** — logic errors, edge cases, off-by-one errors
3. **Security** — injection, auth issues, unsafe operations
4. **Performance** — inefficiencies, unnecessary allocations, N+1 queries
5. **Code quality** — naming, structure, duplication, readability
6. **Tests** — missing coverage, weak assertions
7. **Verdict** — Approve / Request changes / Needs discussion

Be specific: quote the relevant code and explain why it's an issue. Suggest concrete fixes.`;

        let fullResponse = '';
        for await (const chunk of aiClient.streamText(
          [{ role: 'user', content: reviewPrompt }],
          {},
        )) {
          fullResponse += chunk;
          await streamer.push(chunk);
        }
        await streamer.finish();

        // Replace "Reviewing PR..." with the actual first chunk via editReply
        // streamer handles the rest
      } catch (err) {
        logger.error({ err }, 'Error in /review command');
        await interaction.editReply(formatApiError(err));
      }
    },
  };
}

function parsePRInput(input: string): { owner: string; repo: string; prNumber: number } | null {
  // Format: https://github.com/owner/repo/pull/123
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], prNumber: parseInt(urlMatch[3], 10) };
  }

  // Format: owner/repo#123
  const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], prNumber: parseInt(shortMatch[3], 10) };
  }

  return null;
}
