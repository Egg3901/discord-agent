import { SlashCommandBuilder, type ChatInputCommandInteraction, type TextChannel } from 'discord.js';
import type { AIClient, UsageInfo } from '../../claude/aiClient.js';
import { getProviderForModel } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { formatApiError } from '../../utils/errors.js';
import { isAllowed } from '../middleware/permissions.js';
import { logUsage } from '../../storage/database.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import type { CommandHandler } from './types.js';
import type { GuildMember } from 'discord.js';

export function createAskCommand(
  aiClient: AIClient,
  rateLimiter: RateLimiter,
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

      await interaction.deferReply();

      const thinkingMsg = await interaction.editReply('Thinking...');
      const channel = interaction.channel;
      if (!channel) {
        await interaction.editReply('This command must be used in a channel.');
        return;
      }

      const streamer = new ResponseStreamer(channel as TextChannel, thinkingMsg as any);

      try {
        const isCC = getProviderForModel(config.ANTHROPIC_MODEL) === 'claude-code';
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

        if (isCC) {
          for await (const event of aiClient.streamResponse([{ role: 'user', content: question }], usageHandler)) {
            if (event.type === 'text') {
              await streamer.push(event.text);
            } else if (event.type === 'tool_use') {
              await channel.send(`> \u{1F527} \`${event.name}\``);
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
    },
  };
}
