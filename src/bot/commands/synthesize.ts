import {
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AIClient, getProviderForModel } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { formatApiError } from '../../utils/errors.js';
import { isAdmin } from '../middleware/permissions.js';
import { logger } from '../../utils/logger.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { ToolExecutor } from '../../tools/toolExecutor.js';
import { runAgentLoop } from '../../claude/agentLoop.js';
import { config } from '../../config.js';
import { TOOL_EMOJIS, TOOL_LABELS, formatToolDetail, formatCCToolDetail } from '../../utils/toolDisplay.js';
import { rateLimitEmbed, BotColors } from '../../utils/embedHelpers.js';
import type { CommandHandler } from './types.js';
import type { GuildMember } from 'discord.js';

/** Validate a GitHub repo URL and return owner/repo, or null. */
function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export function createSynthesizeCommand(
  sessionManager: SessionManager,
  aiClient: AIClient,
  rateLimiter: RateLimiter,
  repoFetcher: RepoFetcher,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('synthesize')
      .setDescription('Start a dual-repo coding session — bridge two repositories together')
      .addStringOption((opt) =>
        opt
          .setName('primary')
          .setDescription('Primary repository URL (this is the repo you will edit)')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('secondary')
          .setDescription('Secondary repository URL (read-only reference, editable on request)')
          .setRequired(true)
          .setAutocomplete(true),
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
        logger.debug({ err }, 'Synthesize autocomplete failed');
        await interaction.respond([]);
      }
    },

    async execute(interaction: ChatInputCommandInteraction) {
      // --- Permission & rate limit checks ---
      if (!isAdmin(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'This command requires administrator permissions.',
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

      const primaryUrl = interaction.options.getString('primary', true);
      const secondaryUrl = interaction.options.getString('secondary', true);

      // --- Validate repo URLs ---
      const primaryParsed = parseRepoUrl(primaryUrl);
      const secondaryParsed = parseRepoUrl(secondaryUrl);

      if (!primaryParsed) {
        await interaction.reply({
          content: `Invalid primary repository URL: \`${primaryUrl}\`\nExpected format: \`https://github.com/owner/repo\``,
          ephemeral: true,
        });
        return;
      }

      if (!secondaryParsed) {
        await interaction.reply({
          content: `Invalid secondary repository URL: \`${secondaryUrl}\`\nExpected format: \`https://github.com/owner/repo\``,
          ephemeral: true,
        });
        return;
      }

      if (primaryParsed.owner === secondaryParsed.owner && primaryParsed.repo === secondaryParsed.repo) {
        await interaction.reply({
          content: 'Primary and secondary repositories must be different. Use `/code` for single-repo sessions.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const channel = interaction.channel;
        const isDm = !interaction.guild;

        if (!channel) {
          await interaction.editReply('Could not access the channel.');
          return;
        }

        if (!isDm && !('threads' in channel)) {
          await interaction.editReply('This command must be used in a text channel.');
          return;
        }

        // --- Fetch both repos in parallel ---
        await interaction.editReply('Fetching repositories...');

        const [primaryResult, secondaryResult] = await Promise.allSettled([
          (async () => {
            const tree = await repoFetcher.getTree(primaryParsed.owner, primaryParsed.repo);
            const readmeFiles = await repoFetcher.fetchFiles(primaryParsed.owner, primaryParsed.repo, ['README.md', 'readme.md']);
            return {
              repoUrl: primaryUrl,
              files: [
                { path: '[TREE]', content: tree.join('\n') },
                ...readmeFiles,
              ],
            };
          })(),
          (async () => {
            const tree = await repoFetcher.getTree(secondaryParsed.owner, secondaryParsed.repo);
            const readmeFiles = await repoFetcher.fetchFiles(secondaryParsed.owner, secondaryParsed.repo, ['README.md', 'readme.md']);
            return {
              repoUrl: secondaryUrl,
              files: [
                { path: '[TREE]', content: tree.join('\n') },
                ...readmeFiles,
              ],
            };
          })(),
        ]);

        // --- Handle fetch failures ---
        if (primaryResult.status === 'rejected') {
          logger.warn({ err: primaryResult.reason, primaryUrl }, 'Failed to fetch primary repo for /synthesize');
          await interaction.editReply(
            `Failed to fetch primary repository \`${primaryParsed.owner}/${primaryParsed.repo}\`: ${primaryResult.reason?.message || 'Unknown error'}.\nIs it accessible? Try configuring a \`GITHUB_TOKEN\` with \`/admin setgittoken\`.`,
          );
          return;
        }

        if (secondaryResult.status === 'rejected') {
          logger.warn({ err: secondaryResult.reason, secondaryUrl }, 'Failed to fetch secondary repo for /synthesize');
          await interaction.editReply(
            `Failed to fetch secondary repository \`${secondaryParsed.owner}/${secondaryParsed.repo}\`: ${secondaryResult.reason?.message || 'Unknown error'}.\nIs it accessible? Try configuring a \`GITHUB_TOKEN\` with \`/admin setgittoken\`.`,
          );
          return;
        }

        const primaryRepoContext = primaryResult.value;
        const secondaryRepoContext = secondaryResult.value;

        // --- Create thread ---
        let sessionChannel: TextChannel | ThreadChannel | import('discord.js').DMChannel;
        if (isDm) {
          sessionChannel = channel as import('discord.js').DMChannel;
        } else {
          const threadName = `🔗 ${primaryParsed.owner}/${primaryParsed.repo} ↔ ${secondaryParsed.owner}/${secondaryParsed.repo}`;
          const thread = await (channel as TextChannel).threads.create({
            name: threadName.slice(0, 100),
            autoArchiveDuration: 60,
            reason: `Synthesize session started by ${interaction.user.tag}`,
          });
          sessionChannel = thread;
        }

        // --- Create session with both repos ---
        const session = sessionManager.createSession(
          interaction.user.id,
          sessionChannel.id,
          channel.id,
          primaryRepoContext,
        );

        session.modelOverride = config.ANTHROPIC_MODEL;
        session.repoOwner = primaryParsed.owner;
        session.repoName = primaryParsed.repo;
        session.secondaryRepoOwner = secondaryParsed.owner;
        session.secondaryRepoName = secondaryParsed.repo;
        session.secondaryRepoContext = secondaryRepoContext;

        // Fetch default branches in background
        repoFetcher.getDefaultBranch(primaryParsed.owner, primaryParsed.repo)
          .then((branch) => { session.defaultBranch = branch; })
          .catch(() => {});
        repoFetcher.getDefaultBranch(secondaryParsed.owner, secondaryParsed.repo)
          .then((branch) => { session.secondaryDefaultBranch = branch; })
          .catch(() => {});

        // --- Send intro embed ---
        const introEmbed = new EmbedBuilder()
          .setColor(BotColors.Info)
          .setTitle('Dual-Repo Synthesis Session')
          .setDescription('Both repositories are loaded and ready. Tell me what you\'d like to do.')
          .addFields(
            {
              name: '📦 Primary (editable)',
              value: `[\`${primaryParsed.owner}/${primaryParsed.repo}\`](${primaryUrl})`,
              inline: true,
            },
            {
              name: '📚 Secondary (reference)',
              value: `[\`${secondaryParsed.owner}/${secondaryParsed.repo}\`](${secondaryUrl})`,
              inline: true,
            },
          )
          .setFooter({ text: 'I can read both repos, edit the primary, and create PRs on either. Ask me what to build!' });

        await sessionChannel.send({ embeds: [introEmbed] });

        // --- Add initial system context as first user message ---
        const initialPrompt = `This is a dual-repo synthesis session.\n\n**Primary repo** (editable): ${primaryParsed.owner}/${primaryParsed.repo} — ${primaryUrl}\n**Secondary repo** (reference): ${secondaryParsed.owner}/${secondaryParsed.repo} — ${secondaryUrl}\n\nI have loaded both repository trees and READMEs. Please explore both repos to understand their relationship, then ask me what I'd like to work on.`;

        sessionManager.addMessage(sessionChannel.id, {
          role: 'user',
          content: initialPrompt,
        });

        await interaction.editReply(
          isDm
            ? `Synthesis session started! Both repos loaded — send messages here.`
            : `Synthesis session started! Continue in <#${sessionChannel.id}>`,
        );

        // --- Stream initial response ---
        const thinkingMsg = await sessionChannel.send('Thinking...');
        const streamer = new ResponseStreamer(sessionChannel, thinkingMsg);

        const thinkingStart = Date.now();
        const thinkingTimer = setInterval(() => {
          const secs = Math.round((Date.now() - thinkingStart) / 1000);
          thinkingMsg.edit(`Thinking... (${secs}s)`).catch(() => {});
        }, 15_000);

        const streamOptions = {
          repoContext: session.repoContext,
          secondaryRepoContext: session.secondaryRepoContext,
          modelOverride: session.modelOverride,
          sessionId: session.id,
          customSystemPrompt: session.systemPrompt,
          sessionBaseBranch: session.defaultBranch,
          sessionSecondaryBaseBranch: session.secondaryDefaultBranch,
          enableSecondaryRepo: true,
          onQueuePosition: (pos: number) => {
            thinkingMsg.edit(`In queue (position ${pos})...`).catch(() => {});
          },
          onStatus: (status: string) => {
            thinkingMsg.edit(status).catch(() => {});
          },
          onUsage: (usage: import('../../claude/aiClient.js').UsageInfo) => {
            import('../../storage/database.js').then(({ logUsage }) => {
              logUsage({
                userId: interaction.user.id,
                sessionId: session.id,
                keyId: usage.keyId,
                tokensIn: usage.tokensIn,
                tokensOut: usage.tokensOut,
                model: usage.model,
                costUsd: usage.costUsd,
              });
            }).catch(() => {});
          },
        };

        try {
          const hasWebSearch = config.ENABLE_WEB_SEARCH;
          const effectiveModel = session.modelOverride || config.ANTHROPIC_MODEL;
          const isCC = getProviderForModel(effectiveModel) === 'claude-code';

          if (isCC) {
            // Claude Code: handles tools internally
            const loopStart = Date.now();
            let fullResponse = '';
            let toolCallCount = 0;
            let detached = false;
            let lastToolMsg: import('discord.js').Message | null = null;
            for await (const event of aiClient.streamResponse(session.messages, { ...streamOptions, enableWebSearch: hasWebSearch })) {
              if (event.type === 'text') {
                if (toolCallCount > 0 && !detached) {
                  detached = true;
                  clearInterval(thinkingTimer);
                  await streamer.detachForNewMessage(`*Used ${toolCallCount} tool(s)*`);
                }
                fullResponse += event.text;
                await streamer.push(event.text);
              } else if (event.type === 'tool_use') {
                if (lastToolMsg) {
                  await lastToolMsg.edit(`${lastToolMsg.content} \u2014 \u2713`).catch(() => {});
                }
                toolCallCount++;
                const detail = formatCCToolDetail(event.name, event.input);
                lastToolMsg = await sessionChannel.send(`> \u{1F527} \`${event.name}\`${detail ? ` ${detail}` : ''}`);
              }
            }
            if (lastToolMsg) {
              await lastToolMsg.edit(`${lastToolMsg.content} \u2014 \u2713`).catch(() => {});
            }
            clearInterval(thinkingTimer);
            await streamer.finish();
            sessionManager.addMessage(sessionChannel.id, { role: 'assistant', content: fullResponse });
            if (toolCallCount > 0) {
              const elapsed = ((Date.now() - loopStart) / 1000).toFixed(1);
              await sessionChannel.send(`<@${interaction.user.id}> Done \u2014 ${toolCallCount} tool call(s) in ${elapsed}s`);
            }
          } else {
            // Agentic mode — set up tool executor with dual-repo support
            const loopStart = Date.now();
            const toolExecutor = new ToolExecutor(
              repoFetcher,
              primaryParsed.owner,
              primaryParsed.repo,
              session.id,
              primaryUrl,
              session.defaultBranch,
            );

            // Attach secondary repo
            toolExecutor.setSecondaryRepo(
              secondaryParsed.owner,
              secondaryParsed.repo,
              secondaryUrl,
              session.secondaryDefaultBranch,
            );

            let lastToolMsg: import('discord.js').Message | null = null;
            let agentToolCount = 0;
            let agentDetached = false;
            const result = await runAgentLoop(
              aiClient,
              session.messages,
              toolExecutor,
              {
                ...streamOptions,
                enableRepoTools: true,
                enableSecondaryRepo: true,
                enableWebSearch: hasWebSearch,
              },
              {
                onTextChunk: async (text) => {
                  if (agentToolCount > 0 && !agentDetached) {
                    agentDetached = true;
                    clearInterval(thinkingTimer);
                    await streamer.detachForNewMessage(`*Used ${agentToolCount} tool(s)*`);
                  }
                  await streamer.push(text);
                },
                onToolStart: async (name, input) => {
                  agentToolCount++;
                  const emoji = TOOL_EMOJIS[name] || '\u{1F527}';
                  const label = TOOL_LABELS[name] || name;
                  const detail = formatToolDetail(name, input);
                  lastToolMsg = await sessionChannel.send(`> ${emoji} ${label}${detail ? ` ${detail}` : ''}`);
                },
                onToolEnd: async (_name, toolResult) => {
                  if (!lastToolMsg) return;
                  const summary = toolResult.startsWith('Error:')
                    ? '\u274C'
                    : `\u2713 ${toolResult.split('\n')[0].trim().slice(0, 80)}`;
                  await lastToolMsg.edit(`${lastToolMsg.content} \u2014 ${summary}`).catch(() => {});
                  lastToolMsg = null;
                },
                onThinking: async () => {},
                onProgress: async (_iter, tools, elapsed) => {
                  const secs = Math.round(elapsed / 1000);
                  thinkingMsg.edit(`Working... (${tools} tool call${tools !== 1 ? 's' : ''}, ${secs}s)`).catch(() => {});
                },
              },
            );
            clearInterval(thinkingTimer);
            await streamer.finish();
            for (const msg of result.newMessages) {
              sessionManager.addMessage(sessionChannel.id, msg);
            }
            if (result.toolCallCount > 0) {
              const elapsed = ((Date.now() - loopStart) / 1000).toFixed(1);
              await sessionChannel.send(`<@${interaction.user.id}> Done \u2014 ${result.toolCallCount} tool call(s) in ${elapsed}s`);
            }
          }
        } catch (err) {
          clearInterval(thinkingTimer);
          logger.error({ err }, 'Error streaming in /synthesize');
          await streamer.sendError(formatApiError(err));
        }
      } catch (err) {
        logger.error({ err }, 'Error in /synthesize command');
        const msg = err instanceof Error && 'userMessage' in err
          ? (err as any).userMessage
          : 'Failed to start a synthesis session. Please try again.';
        await interaction.editReply(msg);
      }
    },
  };
}
