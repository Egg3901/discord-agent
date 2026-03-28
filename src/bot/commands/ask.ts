import { SlashCommandBuilder, type ChatInputCommandInteraction, type TextChannel } from 'discord.js';
import type { AIClient, UsageInfo } from '../../claude/aiClient.js';
import { getProviderForModel } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { formatApiError } from '../../utils/errors.js';
import { isAllowed } from '../middleware/permissions.js';
import { logUsage } from '../../storage/database.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { nanoid } from 'nanoid';
import type { CommandHandler } from './types.js';
import type { GuildMember } from 'discord.js';

export function createAskCommand(
  aiClient: AIClient,
  rateLimiter: RateLimiter,
  sessionManager: SessionManager,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Ask Claude a one-shot question')
      .addStringOption((opt) =>
        opt
          .setName('question')
          .setDescription('Your question')
          .setRequired(true),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('thread')
          .setDescription('Start a session thread for follow-up conversation')
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

      const question = interaction.options.getString('question', true);
      const startThread = interaction.options.getBoolean('thread') || false;

      const channel = interaction.channel;
      if (!channel) {
        await interaction.reply({
          content: 'This command must be used in a channel.',
          ephemeral: true,
        });
        return;
      }

      const usageHandler = {
        onUsage: (usage: UsageInfo) => {
          logUsage({
            userId: interaction.user.id,
            keyId: usage.keyId,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            model: usage.model,
            costUsd: usage.costUsd,
          });
        },
      };

      if (startThread && 'threads' in channel) {
        // Thread mode: create a thread, session, and stream into it
        await interaction.deferReply({ ephemeral: true });

        try {
          const threadName = question.slice(0, 95) + (question.length > 95 ? '...' : '');
          const thread = await (channel as TextChannel).threads.create({
            name: `\u2753 ${threadName}`,
            autoArchiveDuration: 60,
            reason: `Ask session started by ${interaction.user.tag}`,
          });

          const session = sessionManager.createSession(
            interaction.user.id,
            thread.id,
            channel.id,
          );

          sessionManager.addMessage(thread.id, {
            role: 'user',
            content: question,
          });

          await interaction.editReply(
            `Session started! Continue the conversation in <#${thread.id}>`,
          );

          const thinkingMsg = await thread.send('Thinking...');
          const streamer = new ResponseStreamer(thread, thinkingMsg);

          try {
            const isCC = getProviderForModel(config.ANTHROPIC_MODEL) === 'claude-code';
            let fullResponse = '';

            if (isCC) {
              for await (const event of aiClient.streamResponse([{ role: 'user', content: question }], { ...usageHandler, sessionId: session.id })) {
                if (event.type === 'text') {
                  fullResponse += event.text;
                  await streamer.push(event.text);
                } else if (event.type === 'tool_use') {
                  await thread.send(`> \u{1F527} \`${event.name}\``);
                }
              }
            } else {
              for await (const chunk of aiClient.streamText([{ role: 'user', content: question }], usageHandler)) {
                fullResponse += chunk;
                await streamer.push(chunk);
              }
            }
            await streamer.finish();
            sessionManager.addMessage(thread.id, { role: 'assistant', content: fullResponse });
          } catch (err) {
            logger.error({ err }, 'Error streaming in /ask thread');
            await streamer.sendError(formatApiError(err));
          }
        } catch (err) {
          logger.error({ err }, 'Error in /ask thread setup');
          await interaction.editReply('Failed to start a threaded session. Please try again.');
        }
      } else {
        // Default one-shot mode
        await interaction.deferReply();

        const thinkingMsg = await interaction.editReply('Thinking...');
        const streamer = new ResponseStreamer(channel as TextChannel, thinkingMsg as any);

        try {
          const isCC = getProviderForModel(config.ANTHROPIC_MODEL) === 'claude-code';

          if (isCC) {
            for await (const event of aiClient.streamResponse([{ role: 'user', content: question }], { ...usageHandler, sessionId: `ask_${nanoid(8)}` })) {
              if (event.type === 'text') {
                await streamer.push(event.text);
              } else if (event.type === 'tool_use') {
                await (channel as TextChannel).send(`> \u{1F527} \`${event.name}\``);
              }
            }
          } else {
            for await (const chunk of aiClient.streamText([{ role: 'user', content: question }], usageHandler)) {
              await streamer.push(chunk);
            }
          }
          await streamer.finish();
        } catch (err) {
          logger.error({ err }, 'Error in /ask command');
          await streamer.sendError(formatApiError(err));
        }
      }
    },
  };
}
