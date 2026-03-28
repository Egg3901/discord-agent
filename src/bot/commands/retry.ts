import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AIClient, getProviderForModel } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { isAllowed } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';

export function createRetryCommand(
  sessionManager: SessionManager,
  aiClient: AIClient,
  rateLimiter: RateLimiter,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('retry')
      .setDescription('Retry the last response (removes it and re-generates)'),

    async execute(interaction: ChatInputCommandInteraction) {
      try {
        if (!isAllowed(interaction.member as GuildMember | null)) {
          await interaction.reply({ content: 'You do not have a role that allows using this bot.', ephemeral: true });
          return;
        }

        if (!rateLimiter.check(interaction.user.id)) {
          await interaction.reply({ content: 'Rate limit exceeded. Please wait a moment.', ephemeral: true });
          return;
        }

        const session = sessionManager.getByThread(interaction.channelId);
        if (!session) {
          await interaction.reply({ content: 'No active session in this thread.', ephemeral: true });
          return;
        }

        if (session.userId !== interaction.user.id) {
          await interaction.reply({ content: 'Only the session owner can retry.', ephemeral: true });
          return;
        }

        if (session.messages.length < 2) {
          await interaction.reply({ content: 'No previous response to retry.', ephemeral: true });
          return;
        }

        // Pop the last assistant message
        const lastMsg = session.messages[session.messages.length - 1];
        if (lastMsg.role !== 'assistant') {
          await interaction.reply({ content: 'Last message is not an assistant response. Nothing to retry.', ephemeral: true });
          return;
        }

        session.messages.pop();

        await interaction.deferReply();
        const thinkingMsg = await interaction.editReply('Retrying...');
        const channel = interaction.channel;
        if (!channel) return;

        const streamer = new ResponseStreamer(channel as any, thinkingMsg as any);

        const effectiveModel = session.modelOverride || config.ANTHROPIC_MODEL;
        const isCC = getProviderForModel(effectiveModel) === 'claude-code';

        let fullResponse = '';
        if (isCC) {
          for await (const event of aiClient.streamResponse(session.messages, {
            modelOverride: session.modelOverride,
            sessionId: session.id,
          })) {
            if (event.type === 'text') {
              fullResponse += event.text;
              await streamer.push(event.text);
            } else if (event.type === 'tool_use') {
              await (channel as any).send(`> \u{1F527} \`${event.name}\``);
            }
          }
        } else {
          for await (const chunk of aiClient.streamText(session.messages, {
            repoContext: session.repoContext,
            modelOverride: session.modelOverride,
            sessionId: session.id,
          })) {
            fullResponse += chunk;
            await streamer.push(chunk);
          }
        }

        await streamer.finish();
        sessionManager.addMessage(interaction.channelId, { role: 'assistant', content: fullResponse });
      } catch (err) {
        logger.error({ err }, 'Error in /retry');
        const msg = formatApiError(err);
        if (interaction.deferred) {
          await interaction.editReply(msg).catch(() => {});
        } else {
          await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        }
      }
    },
  };
}
