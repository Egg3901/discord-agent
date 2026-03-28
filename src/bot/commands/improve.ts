import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import type { AIClient } from '../../claude/aiClient.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { isAllowed } from '../middleware/permissions.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';

/**
 * Generate an improved version of a coding prompt.
 * Returns the original prompt unchanged if improvement fails or is identical.
 */
export async function generateImprovedPrompt(aiClient: AIClient, prompt: string): Promise<string> {
  try {
    const result = await aiClient.getResponse(
      [{
        role: 'user',
        content: `Improve this coding request to be more specific, technical, and actionable. Preserve the original intent exactly. Return ONLY the improved prompt text — no explanation, no preamble, no quotes:\n\n${prompt}`,
      }],
      {},
    );
    const improved = result.trim();
    return improved || prompt;
  } catch (err) {
    logger.debug({ err }, 'Prompt improvement failed, using original');
    return prompt;
  }
}

export function createImproveCommand(aiClient: AIClient, rateLimiter: RateLimiter): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('improve')
      .setDescription('Improve a prompt before using it with /code')
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

      const improved = await generateImprovedPrompt(aiClient, prompt);

      if (!improved || improved.trim() === prompt.trim()) {
        await interaction.editReply(`Your prompt looks good as-is:\n\`\`\`\n${prompt}\n\`\`\``);
        return;
      }

      await interaction.editReply([
        `**Original:**`,
        `\`\`\``,
        prompt,
        `\`\`\``,
        `**Improved:**`,
        `\`\`\``,
        improved,
        `\`\`\``,
        `*Use \`/code\` with the improved version, or copy it above.*`,
      ].join('\n'));
    },
  };
}
