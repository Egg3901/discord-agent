import {
  Client,
  Message,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
  type TextChannel,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isAdmin } from '../middleware/permissions.js';
import { BotColors } from '../../utils/embedHelpers.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AIClient } from '../../claude/aiClient.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { config } from '../../config.js';
import { logUsage } from '../../storage/database.js';
import { formatApiError } from '../../utils/errors.js';

// Matches GitHub PR URLs: https://github.com/owner/repo/pull/123
const PR_PATTERN = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\b/g;
// Matches GitHub repo URLs (not PRs/issues/etc): https://github.com/owner/repo
const REPO_PATTERN = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\s|$|[)\]>])/g;

/**
 * Detects GitHub PR and repo links in non-thread guild messages
 * and offers contextual action buttons.
 */
export function handleGithubLinkDetect(
  client: Client,
  sessionManager: SessionManager,
  aiClient: AIClient,
  repoFetcher: RepoFetcher,
): void {
  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    // Only detect in regular guild text channels (not threads, not DMs)
    if (
      message.channel.type !== ChannelType.GuildText &&
      message.channel.type !== ChannelType.GuildAnnouncement
    ) {
      return;
    }

    // Quick check — skip messages without github.com
    if (!message.content.includes('github.com/')) return;

    // Access check
    if (!isAdmin(message.member)) return;

    try {
      // Check for PR links first (more specific)
      const prMatches = [...message.content.matchAll(PR_PATTERN)];
      if (prMatches.length > 0) {
        const [, owner, repo, prNumberStr] = prMatches[0];
        const prNumber = parseInt(prNumberStr, 10);
        const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

        const embed = new EmbedBuilder()
          .setColor(BotColors.GitHub)
          .setDescription(`Detected PR: **${owner}/${repo}#${prNumber}**`)
          .setFooter({ text: 'Click below to start a review or coding session' });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`gh_review_${owner}_${repo}_${prNumber}`)
            .setLabel('Review PR')
            .setEmoji('🔍')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`gh_code_${owner}_${repo}`)
            .setLabel('Code with Repo')
            .setEmoji('💻')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setURL(prUrl)
            .setLabel('Open on GitHub')
            .setStyle(ButtonStyle.Link),
        );

        const reply = await message.reply({ embeds: [embed], components: [row] });

        // Listen for button clicks (60 second window)
        const collector = reply.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 60_000,
        });

        collector.on('collect', async (btn) => {
          if (btn.user.id !== message.author.id) {
            await btn.reply({ content: 'Only the link poster can use these buttons.', ephemeral: true });
            return;
          }

          collector.stop();

          if (btn.customId.startsWith('gh_review_')) {
            await btn.deferUpdate();

            // Create a review thread and stream the review directly
            const channel = message.channel as TextChannel;
            let reviewThread: any;
            try {
              reviewThread = await channel.threads.create({
                name: `\u{1F50D} Review: ${owner}/${repo}#${prNumber}`,
                autoArchiveDuration: 60,
                reason: `PR review started by ${message.author.tag}`,
              });
            } catch (err) {
              logger.error({ err }, 'Failed to create review thread');
              await channel.send(`<@${message.author.id}> Failed to create review thread. Use \`/review pr:${prUrl}\` instead.`);
              return;
            }

            // Fetch PR diff
            let prContext: string;
            try {
              prContext = await repoFetcher.fetchPR(owner, repo, prNumber);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await reviewThread.send(`Failed to fetch PR: ${msg}`);
              return;
            }

            // Create session in the review thread
            const repoContext = {
              repoUrl: `https://github.com/${owner}/${repo}`,
              files: [{ path: `PR #${prNumber} diff`, content: prContext }],
            };

            let session: import('../../sessions/session.js').Session;
            try {
              session = sessionManager.createSession(
                message.author.id,
                reviewThread.id,
                channel.id,
                repoContext,
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await reviewThread.send(`Could not create session: ${msg}`);
              return;
            }

            session.modelOverride = config.ANTHROPIC_MODEL;
            session.repoOwner = owner;
            session.repoName = repo;
            repoFetcher.getDefaultBranch(owner, repo)
              .then((branch) => { session.defaultBranch = branch; })
              .catch(() => {});

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

            sessionManager.addMessage(reviewThread.id, { role: 'user', content: reviewPrompt });

            const thinkingMsg = await reviewThread.send('Reviewing PR...');
            const streamer = new ResponseStreamer(reviewThread, thinkingMsg);

            try {
              let fullResponse = '';
              for await (const chunk of aiClient.streamText(
                session.messages,
                {
                  modelOverride: session.modelOverride,
                  sessionId: session.id,
                  onUsage: (usage) => {
                    logUsage({
                      userId: message.author.id,
                      sessionId: session.id,
                      keyId: usage.keyId,
                      tokensIn: usage.tokensIn,
                      tokensOut: usage.tokensOut,
                      model: usage.model,
                      costUsd: usage.costUsd,
                    });
                  },
                },
              )) {
                fullResponse += chunk;
                await streamer.push(chunk);
              }
              await streamer.finish();
              sessionManager.addMessage(reviewThread.id, { role: 'assistant', content: fullResponse });
              await reviewThread.send(`<@${message.author.id}> Review complete — ask follow-up questions here.`);
            } catch (err) {
              await streamer.sendError(formatApiError(err));
            }
          } else if (btn.customId.startsWith('gh_code_')) {
            await btn.reply({
              content: `Use \`/code prompt:your task here repo:https://github.com/${owner}/${repo}\` to start a coding session with this repo.`,
              ephemeral: true,
            });
          }
        });

        collector.on('end', () => {
          reply.edit({ components: [] }).catch(() => {});
        });

        return; // Don't also match as repo link
      }

      // Check for repo links (less specific)
      const repoMatches = [...message.content.matchAll(REPO_PATTERN)];
      if (repoMatches.length > 0) {
        const [, owner, repo] = repoMatches[0];
        // Filter out non-repo paths (issues, actions, etc.)
        if (['pull', 'issues', 'actions', 'settings', 'wiki', 'releases', 'tags'].includes(repo)) return;

        const embed = new EmbedBuilder()
          .setColor(BotColors.GitHub)
          .setDescription(`Detected repo: **${owner}/${repo}**`)
          .setFooter({ text: 'Click below to start a coding session with this repo' });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`gh_code_${owner}_${repo}`)
            .setLabel('Code with Repo')
            .setEmoji('💻')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setURL(`https://github.com/${owner}/${repo}`)
            .setLabel('Open on GitHub')
            .setStyle(ButtonStyle.Link),
        );

        const reply = await message.reply({ embeds: [embed], components: [row] });

        const collector = reply.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 60_000,
        });

        collector.on('collect', async (btn) => {
          if (btn.user.id !== message.author.id) {
            await btn.reply({ content: 'Only the link poster can use these buttons.', ephemeral: true });
            return;
          }
          if (btn.customId.startsWith('gh_code_')) {
            await btn.reply({
              content: `Use \`/code prompt:your task here repo:https://github.com/${owner}/${repo}\` to start a coding session.`,
              ephemeral: true,
            });
          }
        });

        collector.on('end', () => {
          reply.edit({ components: [] }).catch(() => {});
        });
      }
    } catch (err) {
      logger.debug({ err }, 'GitHub link detection error (non-fatal)');
    }
  });
}
