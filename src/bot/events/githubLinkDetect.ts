import {
  Client,
  Message,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isAllowed } from '../middleware/permissions.js';
import { BotColors } from '../../utils/embedHelpers.js';

// Matches GitHub PR URLs: https://github.com/owner/repo/pull/123
const PR_PATTERN = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\b/g;
// Matches GitHub repo URLs (not PRs/issues/etc): https://github.com/owner/repo
const REPO_PATTERN = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\s|$|[)\]>])/g;

/**
 * Detects GitHub PR and repo links in non-thread guild messages
 * and offers contextual action buttons.
 */
export function handleGithubLinkDetect(client: Client): void {
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
    if (!isAllowed(message.member, message.author.id)) return;

    try {
      // Check for PR links first (more specific)
      const prMatches = [...message.content.matchAll(PR_PATTERN)];
      if (prMatches.length > 0) {
        const [, owner, repo, prNumber] = prMatches[0];
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

          if (btn.customId.startsWith('gh_review_')) {
            await btn.reply({
              content: `Use \`/review pr:${prUrl}\` to start a review session.`,
              ephemeral: true,
            });
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
