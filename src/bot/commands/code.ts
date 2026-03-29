import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ChannelType,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { generateImprovedPrompt } from './improve.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AIClient, getProviderForModel } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { formatApiError } from '../../utils/errors.js';
import { isAllowed } from '../middleware/permissions.js';
import { logger } from '../../utils/logger.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { ToolExecutor } from '../../tools/toolExecutor.js';
import { runAgentLoop } from '../../claude/agentLoop.js';
import { config } from '../../config.js';
import { TOOL_EMOJIS, TOOL_LABELS, formatToolDetail, formatCCToolDetail } from '../../utils/toolDisplay.js';
import type { CommandHandler } from './types.js';
import type { GuildMember } from 'discord.js';

export function createCodeCommand(
  sessionManager: SessionManager,
  aiClient: AIClient,
  rateLimiter: RateLimiter,
  repoFetcher: RepoFetcher,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('code')
      .setDescription('Start a coding session with Claude in a new thread')
      .addStringOption((opt) =>
        opt
          .setName('prompt')
          .setDescription('What do you want to work on?')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('repo')
          .setDescription('GitHub repository URL for context (optional)')
          .setRequired(false)
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
        logger.debug({ err }, 'Code autocomplete failed');
        await interaction.respond([]);
      }
    },

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

      const originalPrompt = interaction.options.getString('prompt', true);
      const repoUrl = interaction.options.getString('repo');

      // Defer ephemeral so we can show the improve prompt flow privately
      await interaction.deferReply({ ephemeral: true });

      let prompt = originalPrompt;

      try {
        const channel = interaction.channel;
        if (!channel || !('threads' in channel)) {
          await interaction.editReply('This command must be used in a text channel.');
          return;
        }

        // --- Prompt improvement flow ---
        const improved = await generateImprovedPrompt(aiClient, originalPrompt);
        const meaningfullyDifferent = improved.trim() !== originalPrompt.trim() && improved.length > 0;

        if (meaningfullyDifferent) {
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('use_improved')
              .setLabel('✅ Use Improved')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('use_original')
              .setLabel('Keep Original')
              .setStyle(ButtonStyle.Secondary),
          );

          const preview = [
            `**Original:** ${originalPrompt}`,
            ``,
            `**Suggested:** ${improved}`,
          ].join('\n').slice(0, 1800);

          await interaction.editReply({ content: preview, components: [row] });

          try {
            const reply = await interaction.fetchReply();
            const btn = await reply.awaitMessageComponent({
              filter: (i: { user: { id: string } }) => i.user.id === interaction.user.id,
              time: 30_000,
              componentType: ComponentType.Button,
            });
            prompt = btn.customId === 'use_improved' ? improved : originalPrompt;
            await btn.deferUpdate();
          } catch {
            // Timed out — use original
          }

          await interaction.editReply({ content: `Starting: *${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}*`, components: [] });
        }
        // --- End improve flow ---

        const threadName = prompt.slice(0, 95) + (prompt.length > 95 ? '...' : '');
        const thread = await (channel as TextChannel).threads.create({
          name: `\u{1F916} ${threadName}`,
          autoArchiveDuration: 60,
          reason: `Coding session started by ${interaction.user.tag}`,
        });

        // Fire-and-forget: generate a better thread name from the prompt
        (async () => {
          try {
            const effectiveModel = config.ANTHROPIC_MODEL;
            // Skip AI naming for CC to avoid subprocess overhead
            if (getProviderForModel(effectiveModel) === 'claude-code') return;
            const title = await aiClient.getResponse(
              [{ role: 'user', content: `Generate a short 4-6 word title for this coding task. Return ONLY the title, no quotes:\n\n${prompt.slice(0, 200)}` }],
              {},
            );
            const cleaned = title.trim().slice(0, 90);
            if (cleaned && cleaned.length > 2) {
              await thread.setName(`🤖 ${cleaned}`);
            }
          } catch { /* non-fatal */ }
        })();

        // Parse repo if provided
        let repoOwner: string | undefined;
        let repoName: string | undefined;
        let repoContext: { repoUrl: string; files: { path: string; content: string }[] } | undefined;

        if (repoUrl) {
          try {
            const parsed = repoFetcher.parseGitHubUrl(repoUrl);
            repoOwner = parsed.owner;
            repoName = parsed.repo;

            // When tools are available, fetch only tree listing + README for initial context
            // instead of 20 files — the AI can read individual files on demand via tools
            const tree = await repoFetcher.getTree(repoOwner, repoName);
            const readmeFiles = await repoFetcher.fetchFiles(repoOwner, repoName, ['README.md', 'readme.md']);
            repoContext = {
              repoUrl,
              files: [
                { path: '[TREE]', content: tree.join('\n') },
                ...readmeFiles,
              ],
            };
          } catch (err) {
            logger.warn({ err, repoUrl }, 'Failed to fetch repo for /code');
            await thread.send('> Failed to load repository context. Continuing without it.');
            repoOwner = undefined;
            repoName = undefined;
            repoContext = undefined;
          }
        }

        const session = sessionManager.createSession(
          interaction.user.id,
          thread.id,
          channel.id,
          repoContext,
        );

        // Lock the effective model at session creation so follow-up messages
        // don't break if the global default changes mid-session.
        session.modelOverride = config.ANTHROPIC_MODEL;

        // Set repo owner/name on session for tool executor
        if (repoOwner && repoName) {
          session.repoOwner = repoOwner;
          session.repoName = repoName;
        }

        sessionManager.addMessage(thread.id, {
          role: 'user',
          content: prompt,
        });

        await interaction.editReply(
          `Session started! Continue the conversation in <#${thread.id}>${repoUrl ? ` (repo: ${repoOwner}/${repoName})` : ''}`,
        );

        const thinkingMsg = await thread.send('Thinking...');
        const streamer = new ResponseStreamer(thread, thinkingMsg);

        // Periodically update the thinking message with elapsed time so users
        // know the bot is alive during long CC or complex requests.
        const thinkingStart = Date.now();
        const thinkingTimer = setInterval(() => {
          const secs = Math.round((Date.now() - thinkingStart) / 1000);
          thinkingMsg.edit(`Thinking... (${secs}s)`).catch(() => {});
        }, 15_000);

        const streamOptions = {
          repoContext: session.repoContext,
          modelOverride: session.modelOverride,
          sessionId: session.id,
          customSystemPrompt: session.systemPrompt,
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
          const hasRepo = repoOwner && repoName;
          const hasWebSearch = config.ENABLE_WEB_SEARCH;
          const effectiveModel = session.modelOverride || config.ANTHROPIC_MODEL;
          const isCC = getProviderForModel(effectiveModel) === 'claude-code';

          if (isCC) {
            // Claude Code: handles tools internally — stream events directly,
            // displaying tool notifications without re-executing them.
            const loopStart = Date.now();
            let fullResponse = '';
            let toolCallCount = 0;
            let lastToolMsg: import('discord.js').Message | null = null;
            for await (const event of aiClient.streamResponse(session.messages, { ...streamOptions, enableWebSearch: hasWebSearch })) {
              if (event.type === 'text') {
                fullResponse += event.text;
                await streamer.push(event.text);
              } else if (event.type === 'tool_use') {
                // Mark previous tool as done when a new one starts
                if (lastToolMsg) {
                  await lastToolMsg.edit(`${lastToolMsg.content} \u2014 \u2713`).catch(() => {});
                }
                toolCallCount++;
                const detail = formatCCToolDetail(event.name, event.input);
                lastToolMsg = await thread.send(`> \u{1F527} \`${event.name}\`${detail ? ` ${detail}` : ''}`);
              }
            }
            // Mark the last tool as done
            if (lastToolMsg) {
              await lastToolMsg.edit(`${lastToolMsg.content} \u2014 \u2713`).catch(() => {});
              lastToolMsg = null;
            }
            clearInterval(thinkingTimer);
            await streamer.finish();
            sessionManager.addMessage(thread.id, { role: 'assistant', content: fullResponse });
            if (toolCallCount > 0) {
              const elapsed = ((Date.now() - loopStart) / 1000).toFixed(1);
              await thread.send(`<@${interaction.user.id}> Done \u2014 ${toolCallCount} tool call(s) in ${elapsed}s`);
            }
          } else if (hasRepo || config.ENABLE_SCRIPT_EXECUTION || config.ENABLE_DEV_TOOLS || hasWebSearch) {
            // Agentic mode for Anthropic / Gemini
            const loopStart = Date.now();
            const toolExecutor = new ToolExecutor(
              hasRepo ? repoFetcher : null,
              repoOwner || '',
              repoName || '',
              session.id,
              repoUrl || undefined,
            );
            let lastToolMsg: import('discord.js').Message | null = null;
            const result = await runAgentLoop(
              aiClient,
              session.messages,
              toolExecutor,
              { ...streamOptions, enableRepoTools: !!hasRepo, enableWebSearch: hasWebSearch },
              {
                onTextChunk: (text) => streamer.push(text),
                onToolStart: async (name, input) => {
                  const emoji = TOOL_EMOJIS[name] || '\u{1F527}';
                  const label = TOOL_LABELS[name] || name;
                  const detail = formatToolDetail(name, input);
                  lastToolMsg = await thread.send(`> ${emoji} ${label}${detail ? ` ${detail}` : ''}`);
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
              sessionManager.addMessage(thread.id, msg);
            }
            if (result.toolCallCount > 0) {
              const elapsed = ((Date.now() - loopStart) / 1000).toFixed(1);
              await thread.send(`<@${interaction.user.id}> Done \u2014 ${result.toolCallCount} tool call(s) in ${elapsed}s`);
            }
          } else {
            // Simple streaming mode
            clearInterval(thinkingTimer);
            let fullResponse = '';
            for await (const chunk of aiClient.streamText(session.messages, { ...streamOptions, enableWebSearch: hasWebSearch })) {
              fullResponse += chunk;
              await streamer.push(chunk);
            }
            await streamer.finish();
            sessionManager.addMessage(thread.id, { role: 'assistant', content: fullResponse });
          }
        } catch (err) {
          clearInterval(thinkingTimer);
          logger.error({ err }, 'Error streaming in /code');
          await streamer.sendError(formatApiError(err));
        }
      } catch (err) {
        logger.error({ err }, 'Error in /code command');
        const msg = err instanceof Error && 'userMessage' in err
          ? (err as any).userMessage
          : 'Failed to start a coding session. Please try again.';
        await interaction.editReply(msg);
      }
    },
  };
}

// formatCCToolDetail imported from ../../utils/toolDisplay.js
