import {
  SlashCommandBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AIClient } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { formatApiError } from '../../utils/errors.js';
import { isAllowed } from '../middleware/permissions.js';
import { logger } from '../../utils/logger.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { ToolExecutor } from '../../tools/toolExecutor.js';
import { runAgentLoop } from '../../claude/agentLoop.js';
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
          .setRequired(false),
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

      const prompt = interaction.options.getString('prompt', true);
      const repoUrl = interaction.options.getString('repo');

      await interaction.deferReply();

      try {
        const channel = interaction.channel;
        if (!channel || !('threads' in channel)) {
          await interaction.editReply('This command must be used in a text channel.');
          return;
        }

        const threadName = prompt.slice(0, 95) + (prompt.length > 95 ? '...' : '');
        const thread = await (channel as TextChannel).threads.create({
          name: `\u{1F916} ${threadName}`,
          autoArchiveDuration: 60,
          reason: `Coding session started by ${interaction.user.tag}`,
        });

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
          }
        }

        const session = sessionManager.createSession(
          interaction.user.id,
          thread.id,
          channel.id,
          repoContext,
        );

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

        try {
          if (repoOwner && repoName) {
            // Agentic mode
            const toolExecutor = new ToolExecutor(repoFetcher, repoOwner, repoName);
            const result = await runAgentLoop(
              aiClient,
              session.messages,
              toolExecutor,
              {
                repoContext: session.repoContext,
                modelOverride: session.modelOverride,
                onQueuePosition: (pos) => {
                  thinkingMsg.edit(`In queue (position ${pos})...`).catch(() => {});
                },
              },
              {
                onTextChunk: (text) => streamer.push(text),
                onToolStart: async (name, input) => {
                  const inputSummary = Object.entries(input)
                    .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
                    .join(', ');
                  await thread.send(`> \u{1F527} \`${name}\` ${inputSummary}`);
                },
                onToolEnd: async () => {},
                onThinking: async () => {},
              },
            );

            await streamer.finish();

            for (const msg of result.newMessages) {
              sessionManager.addMessage(thread.id, msg);
            }
          } else {
            // Simple streaming mode
            let fullResponse = '';
            for await (const chunk of aiClient.streamText(
              session.messages,
              {
                repoContext: session.repoContext,
                modelOverride: session.modelOverride,
                onQueuePosition: (pos) => {
                  thinkingMsg.edit(`In queue (position ${pos})...`).catch(() => {});
                },
              },
            )) {
              fullResponse += chunk;
              await streamer.push(chunk);
            }
            await streamer.finish();

            sessionManager.addMessage(thread.id, {
              role: 'assistant',
              content: fullResponse,
            });
          }
        } catch (err) {
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
