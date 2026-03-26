import {
  Client,
  Message,
  ChannelType,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AnthropicClient } from '../../claude/anthropicClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';

export function handleMessageCreate(
  client: Client,
  sessionManager: SessionManager,
  anthropicClient: AnthropicClient,
  rateLimiter: RateLimiter,
): void {
  client.on('messageCreate', async (message: Message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Only handle messages in threads
    if (
      message.channel.type !== ChannelType.PublicThread &&
      message.channel.type !== ChannelType.PrivateThread
    ) {
      return;
    }

    const threadId = message.channel.id;
    const session = sessionManager.getByThread(threadId);
    if (!session) return; // Not a session thread

    // Rate limit check
    if (!rateLimiter.check(message.author.id)) {
      await message.reply('You\'re sending messages too fast. Please wait a moment.');
      return;
    }

    const channel = message.channel as ThreadChannel;

    try {
      // Show typing indicator
      await channel.sendTyping();

      // Add user message to session
      sessionManager.addMessage(threadId, {
        role: 'user',
        content: message.content,
      });

      // Send initial "thinking" message
      const thinkingMsg = await channel.send('Thinking...');

      // Stream the response
      const streamer = new ResponseStreamer(channel, thinkingMsg);

      try {
        let fullResponse = '';
        for await (const chunk of anthropicClient.streamResponse(
          session.messages,
          { repoContext: session.repoContext, modelOverride: session.modelOverride },
        )) {
          fullResponse += chunk;
          await streamer.push(chunk);
        }

        await streamer.finish();

        // Add assistant response to session history
        sessionManager.addMessage(threadId, {
          role: 'assistant',
          content: fullResponse,
        });
      } catch (err) {
        logger.error({ err, sessionId: session.id }, 'Error streaming response');
        await streamer.sendError(
          'Something went wrong generating a response. Please try again.',
        );
      }
    } catch (err) {
      logger.error({ err, threadId }, 'Error handling thread message');
    }
  });
}
