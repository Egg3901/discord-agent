import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config } from '../../config.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import type { CommandHandler } from './types.js';

/**
 * Available Claude models that users can switch between.
 */
const AVAILABLE_MODELS = [
  { name: 'Claude Opus 4.6', value: 'claude-opus-4-6' },
  { name: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { name: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  { name: 'Claude Sonnet 4 (2025-05-14)', value: 'claude-sonnet-4-20250514' },
];

export function createModelCommand(
  sessionManager: SessionManager,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('model')
      .setDescription('Switch the Claude model')
      .addStringOption((opt) =>
        opt
          .setName('model')
          .setDescription('Model to use')
          .setRequired(true)
          .addChoices(...AVAILABLE_MODELS),
      )
      .addStringOption((opt) =>
        opt
          .setName('scope')
          .setDescription('Apply to this session only, or as the new default?')
          .setRequired(false)
          .addChoices(
            { name: 'This session only', value: 'session' },
            { name: 'Default for all new sessions', value: 'default' },
          ),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      const model = interaction.options.getString('model', true);
      const scope = interaction.options.getString('scope') || 'session';
      const modelLabel = AVAILABLE_MODELS.find((m) => m.value === model)?.name ?? model;

      if (scope === 'default') {
        // Change global default (any user can do this — or restrict to admin if preferred)
        config.ANTHROPIC_MODEL = model;
        await interaction.reply({
          content: `Default model changed to **${modelLabel}**. All new sessions will use this model.`,
          ephemeral: true,
        });
        return;
      }

      // Session scope: override model for current thread's session
      const session = sessionManager.getByThread(interaction.channelId);
      if (!session) {
        await interaction.reply({
          content: 'No active session in this thread. Use `/code` to start one, or use `/model <model> scope:default` to change the global default.',
          ephemeral: true,
        });
        return;
      }

      session.modelOverride = model;
      await interaction.reply({
        content: `This session is now using **${modelLabel}**. Other sessions are unaffected.`,
        ephemeral: true,
      });
    },
  };
}
