import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { AIClient } from '../../claude/aiClient.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { isAllowed } from '../middleware/permissions.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';
import type { GuildMember } from 'discord.js';

export async function generateImprovedPrompt(aiClient: AIClient, prompt: string): Promise<string> {
  try {
    const improved = await aiClient.getResponse([
      {
        role: 'user',
        content: `You are a prompt clarity assistant. Rewrite the following coding task prompt to be clearer, more specific, and more actionable. Do not change the intent, do not make bold assumptions about the solution approach, and do not add requirements that weren't implied. Return only the improved prompt text — no explanation, no quotes, no preamble.\n\nOriginal prompt: ${prompt}`,
      },
    ]);
    return improved.trim() || prompt;
  } catch (err) {
    logger.warn({ err }, 'Failed to generate improved prompt');
    return prompt;
  }
}

export function createImproveCommand(aiClient: AIClient, rateLimiter: RateLimiter): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('improve')
      .setDescription('Get a clearer, more specific version of a coding prompt')
      .addStringOption((opt) =>
        opt
          .setName('prompt')
          .setDescription('The prompt to improve')
          .setRequired(true),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAllowed(interaction.member as GuildMember | null)) {
        await interaction.reply({ content: 'You do not have a role that allows using this bot.', ephemeral: true });
        return;
      }

      if (!rateLimiter.check(interaction.user.id)) {
        await interaction.reply({ content: 'Rate limit exceeded. Please wait a moment.', ephemeral: true });
        return;
      }

      const prompt = interaction.options.getString('prompt', true);

      await interaction.deferReply({ ephemeral: true });

      try {
        const improved = await generateImprovedPrompt(aiClient, prompt);

        if (improved === prompt) {
          await interaction.editReply(`**Original prompt:**\n> ${prompt}\n\n*No improvement could be generated.*`);
          return;
        }

        await interaction.editReply(
          `**Original prompt:**\n> ${prompt.replace(/\n/g, '\n> ')}\n\n**Improved prompt:**\n> ${improved.replace(/\n/g, '\n> ')}`,
        );
      } catch (err) {
        logger.error({ err }, 'Error in /improve command');
        await interaction.editReply('Failed to improve prompt. Please try again.');
      }
    },
  };
}
