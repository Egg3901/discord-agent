import { Client, MessageReaction, PartialMessageReaction, User, PartialUser, ChannelType } from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';

export function handleReactionAdd(
  client: Client,
  sessionManager: SessionManager,
): void {
  client.on('messageReactionAdd', async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    // Ignore bot reactions
    if (user.bot) return;

    // Only handle stop sign emoji
    if (reaction.emoji.name !== '🛑') return;

    const message = reaction.message;
    const channel = message.channel;

    // Only in threads
    if (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread) return;

    const session = sessionManager.getByThread(channel.id);
    if (!session) return;

    // Only session owner can stop
    if (session.userId !== user.id) return;

    // Abort the active request
    if (session.activeController) {
      session.activeController.abort();
      session.activeController = undefined;
    }
  });
}
