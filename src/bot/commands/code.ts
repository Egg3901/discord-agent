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
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';

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
        // Create a thread for this session
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

        // Create the session
        const session = sessionManager.createSession(
          interaction.user.id,
          thread.id,
          channel.id,
        );

        // Add initial prompt to session
        sessionManager.addMessage(thread.id, {
          role: 'user',
          content: prompt,
        });

        await interaction.editReply(
          `Session started! Continue the conversation in <#${thread.id}>`,
        );

        // Send initial "thinking" message in the thread
        const thinkingMsg = await thread.send('Thinking...');
        const streamer = new ResponseStreamer(thread, thinkingMsg);

        // Stream the first response
        let fullResponse = '';
        for await (const chunk of anthropicClient.streamResponse(
          session.messages,
          session.repoContext,
        )) {
          fullResponse += chunk;
          await streamer.push(chunk);
        }
        await streamer.finish();

        // Add assistant response to session
        sessionManager.addMessage(thread.id, {
          role: 'assistant',
          content: fullResponse,
        });
      } catch (err) {
        logger.error({ err }, 'Error in /code command');
        await interaction.editReply(
          'Failed to start a coding session. Please try again.',
        );
      }
    },
  };
}
