import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AIClient, UsageInfo } from '../../claude/aiClient.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { formatApiError } from '../../utils/errors.js';
import { isAllowed } from '../middleware/permissions.js';
import { splitMessage } from '../../utils/chunks.js';
import { logUsage } from '../../storage/database.js';
import { logger } from '../../utils/logger.js';
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

      try {
        const response = await aiClient.getResponse([
          { role: 'user', content: question },
        ], {
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
        });

        const chunks = splitMessage(response);
        await interaction.editReply(chunks[0]);

        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      } catch (err) {
        logger.error({ err }, 'Error in /ask command');
        await interaction.editReply(formatApiError(err));
      }
    },
  };
}
