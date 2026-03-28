import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { AIClient } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { SessionManager } from '../../sessions/sessionManager.js';
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
  sessionManager: SessionManager,
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

      await interaction.deferReply({ ephemeral: true });

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

        const channel = interaction.channel;
        if (!channel || !('threads' in channel)) {
          await interaction.editReply('This command must be used in a text channel.');
          return;
        }

        // Create a thread for the review
        const thread = await (channel as TextChannel).threads.create({
          name: `\u{1F50D} Review: ${owner}/${repo}#${prNumber}`,
          autoArchiveDuration: 60,
          reason: `PR review started by ${interaction.user.tag}`,
        });

        // Create a session so the user can follow up with questions
        const session = sessionManager.createSession(
          interaction.user.id,
          thread.id,
          channel.id,
        );

        const reviewPrompt = `You are doing a code review for PR #${prNumber} in ${owner}/${repo}.

${prContext}

Provide a thorough, actionable code review covering:
1. **Summary** \u2014 what does this PR do?
2. **Correctness** \u2014 logic errors, edge cases, off-by-one errors
3. **Security** \u2014 injection, auth issues, unsafe operations
4. **Performance** \u2014 inefficiencies, unnecessary allocations, N+1 queries
5. **Code quality** \u2014 naming, structure, duplication, readability
6. **Tests** \u2014 missing coverage, weak assertions
7. **Verdict** \u2014 Approve / Request changes / Needs discussion

Be specific: quote the relevant code and explain why it's an issue. Suggest concrete fixes.`;

        sessionManager.addMessage(thread.id, {
          role: 'user',
          content: reviewPrompt,
        });

        await interaction.editReply(
          `Review started! See the results in <#${thread.id}>`,
        );

        const thinkingMsg = await thread.send('Reviewing PR...');
        const streamer = new ResponseStreamer(thread, thinkingMsg);

        let fullResponse = '';
        for await (const chunk of aiClient.streamText(
          [{ role: 'user', content: reviewPrompt }],
          {},
        )) {
          fullResponse += chunk;
          await streamer.push(chunk);
        }
        await streamer.finish();

        sessionManager.addMessage(thread.id, { role: 'assistant', content: fullResponse });
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
