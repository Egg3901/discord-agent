import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AIClient } from '../../claude/aiClient.js';
import { isAllowed } from '../middleware/permissions.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';
import type { GuildMember } from 'discord.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { rateLimitEmbed } from '../../utils/embedHelpers.js';

// System prompt for improving user prompts
const IMPROVE_PROMPT_SYSTEM = `You are an expert at optimizing prompts for AI assistants. Your task is to take a user's prompt and make it clearer, more specific, and more effective at getting the desired result.

Guidelines for improving prompts:
1. Maintain the original intent and goal
2. Add clarity and specificity where needed
3. Include relevant context that might be missing
4. Structure the prompt to guide the AI toward better responses
5. Remove ambiguity and vagueness
6. Keep the improved prompt concise but comprehensive

Return ONLY the improved prompt as plain text. Do not include any explanations, formatting, or markdown.`;

export function createImproveCommand(aiClient: AIClient, rateLimiter: RateLimiter): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('improve')
      .setDescription('Optimize your prompt for better AI responses')
      .addStringOption((opt) =>
        opt
          .setName('prompt')
          .setDescription('The prompt you want to improve')
          .setRequired(true),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAllowed(interaction.member as GuildMember | null, interaction.user.id)) {
        await interaction.reply({
          content: 'You do not have a role that allows using this bot.',
          ephemeral: true,
        });
        return;
      }

      if (!rateLimiter.check(interaction.user.id)) {
        await interaction.reply({
          embeds: [rateLimitEmbed(rateLimiter.getInfo(interaction.user.id))],
          ephemeral: true,
        });
        return;
      }

      try {
        await interaction.deferReply();
        
        const originalPrompt = interaction.options.getString('prompt', true);
        
        // Create messages array with our improvement system prompt
        const messages = [
          { role: 'system' as const, content: IMPROVE_PROMPT_SYSTEM },
          { role: 'user' as const, content: originalPrompt },
        ];

        // Get the improved prompt from the AI
        const improvedPrompt = await aiClient.getResponse(
          messages,
          { 
            modelOverride: 'claude-sonnet-4-6', // Use a reliable model for prompt improvement
            enableTools: false 
          }
        );

        // Respond with the improved prompt as plain text
        await interaction.editReply({
          content: `**Improved Prompt:**\n${improvedPrompt.trim()}`,
        });
      } catch (err) {
        logger.error({ err }, 'Error in /improve command');
        await interaction.editReply({
          content: 'Sorry, I encountered an error while improving your prompt. Please try again.',
        });
      }
    },
  };
}