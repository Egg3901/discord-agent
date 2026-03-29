import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { AIClient, getProviderForModel } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { isAllowed } from '../middleware/permissions.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { formatApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { logUsage } from '../../storage/database.js';
import { BotColors, rateLimitEmbed } from '../../utils/embedHelpers.js';
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
      .setDescription('Review a GitHub pull request (creates a session for follow-up)')
      .addStringOption((opt) =>
        opt
          .setName('pr')
          .setDescription('GitHub PR URL (e.g. https://github.com/owner/repo/pull/123) or owner/repo#123')
          .setRequired(true),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAllowed(interaction.member as GuildMember | null, interaction.user.id)) {
        await interaction.reply({
          content: 'You do not have a role that allows using this bot.',
          ephemeral: true,
        });
        return;
      }

      if (!rateLimiter.check(interaction.user.id)) {
        await interaction.reply({
          embeds: [rateLimitEmbed(rateLimiter.getInfo(interaction.user.id))],
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
        const isDm = !interaction.guild;

        if (!channel) {
          await interaction.editReply('Could not access the channel.');
          return;
        }

        // Create thread for review (or use DM channel)
        let reviewChannel: any;
        if (isDm) {
          reviewChannel = channel;
        } else {
          if (!('threads' in channel)) {
            await interaction.editReply('This command must be used in a text channel.');
            return;
          }
          reviewChannel = await (channel as TextChannel).threads.create({
            name: `\u{1F50D} Review: ${owner}/${repo}#${prNumber}`,
            autoArchiveDuration: 60,
            reason: `PR review started by ${interaction.user.tag}`,
          });
        }

        // Create a persistent session so the user can follow up with questions
        const repoContext = {
          repoUrl: `https://github.com/${owner}/${repo}`,
          files: [{ path: `PR #${prNumber} diff`, content: prContext }],
        };

        const session = sessionManager.createSession(
          interaction.user.id,
          reviewChannel.id,
          channel.id,
          repoContext,
        );

        // Lock model + set repo metadata for tool access
        session.modelOverride = config.ANTHROPIC_MODEL;
        session.repoOwner = owner;
        session.repoName = repo;

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

        sessionManager.addMessage(reviewChannel.id, {
          role: 'user',
          content: reviewPrompt,
        });

        // Send confirmation embed
        const confirmEmbed = new EmbedBuilder()
          .setColor(BotColors.GitHub)
          .setTitle(`PR Review: ${owner}/${repo}#${prNumber}`)
          .setDescription(isDm
            ? 'Review started below. Ask follow-up questions to drill into specific findings.'
            : `Review started in <#${reviewChannel.id}>. Ask follow-up questions to drill into specific findings.`)
          .addFields(
            { name: 'Repository', value: `\`${owner}/${repo}\``, inline: true },
            { name: 'PR', value: `#${prNumber}`, inline: true },
            { name: 'Session', value: 'Active — you can ask follow-up questions', inline: true },
          )
          .setURL(`https://github.com/${owner}/${repo}/pull/${prNumber}`)
          .setFooter({ text: 'Session will expire after 30 min of inactivity' })
          .setTimestamp();

        await interaction.editReply({ embeds: [confirmEmbed] });

        // Stream the review
        const thinkingMsg = await reviewChannel.send('Reviewing PR...');
        const streamer = new ResponseStreamer(reviewChannel, thinkingMsg);

        const onUsage = (usage: import('../../claude/aiClient.js').UsageInfo) => {
          logUsage({
            userId: interaction.user.id,
            sessionId: session.id,
            keyId: usage.keyId,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            model: usage.model,
            costUsd: usage.costUsd,
          });
        };

        try {
          let fullResponse = '';
          for await (const chunk of aiClient.streamText(
            session.messages,
            {
              modelOverride: session.modelOverride,
              sessionId: session.id,
              onUsage,
            },
          )) {
            fullResponse += chunk;
            await streamer.push(chunk);
          }
          await streamer.finish();

          sessionManager.addMessage(reviewChannel.id, { role: 'assistant', content: fullResponse });
        } catch (err) {
          await streamer.sendError(formatApiError(err));
        }
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
