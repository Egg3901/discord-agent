import { Client, MessageReaction, PartialMessageReaction, User, PartialUser, ChannelType } from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { logger } from '../../utils/logger.js';

export function handleReactionAdd(
  client: Client,
  sessionManager: SessionManager,
): void {
  client.on('messageReactionAdd', async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    try {
      // Ignore bot reactions
      if (user.bot) return;

      // Only handle stop sign emoji (unicode emoji, not custom)
      if (reaction.emoji.id !== null || reaction.emoji.name !== '🛑') return;

      const message = reaction.message;
      const channel = message.channel;

      // Only in threads
      if (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread) return;

      const session = sessionManager.getByThread(channel.id);
      if (!session) return;

      // Only session owner can stop
      if (session.userId !== user.id) return;

      // Abort the active request (use optional chaining for race safety)
      session.activeController?.abort();
      session.activeController = undefined;
    } catch (err) {
      logger.error({ err }, 'Reaction handler error');
    }
  });
}
