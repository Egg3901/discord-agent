import {
  SlashCommandBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AnthropicClient } from '../../claude/anthropicClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { formatApiError } from '../../utils/errors.js';
import { isAllowed } from '../middleware/permissions.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';
import type { GuildMember } from 'discord.js';

export function createCodeCommand(
  sessionManager: SessionManager,
  anthropicClient: AnthropicClient,
  rateLimiter: RateLimiter,
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
          name: `🤖 ${threadName}`,
          autoArchiveDuration: 60,
          reason: `Coding session started by ${interaction.user.tag}`,
        });

        const session = sessionManager.createSession(
          interaction.user.id,
          thread.id,
          channel.id,
        );

        sessionManager.addMessage(thread.id, {
          role: 'user',
          content: prompt,
        });

        await interaction.editReply(
          `Session started! Continue the conversation in <#${thread.id}>`,
        );

        const thinkingMsg = await thread.send('Thinking...');
        const streamer = new ResponseStreamer(thread, thinkingMsg);

        try {
          let fullResponse = '';
          for await (const chunk of anthropicClient.streamResponse(
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
