import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AnthropicClient } from '../../claude/anthropicClient.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { splitMessage } from '../../utils/chunks.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';

export function createAskCommand(
  anthropicClient: AnthropicClient,
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
        const response = await anthropicClient.getResponse([
          { role: 'user', content: question },
        ]);

        const chunks = splitMessage(response);
        await interaction.editReply(chunks[0]);

        // Send remaining chunks as follow-up messages
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      } catch (err) {
        logger.error({ err }, 'Error in /ask command');
        await interaction.editReply(
          'Something went wrong. Please try again later.',
        );
      }
    },
  };
}
