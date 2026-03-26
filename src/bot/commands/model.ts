import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config } from '../../config.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import type { CommandHandler } from './types.js';

const AVAILABLE_MODELS = [
  // Claude (Anthropic)
  { name: 'Claude Opus 4.6', value: 'claude-opus-4-6' },
  { name: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { name: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  { name: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
  // Gemini (Google)
  { name: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
  { name: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
  { name: 'Gemini 2.0 Flash', value: 'gemini-2.0-flash' },
];

export function createModelCommand(
  sessionManager: SessionManager,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('model')
      .setDescription('Switch the AI model (Claude or Gemini)')
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
      const provider = model.startsWith('gemini-') ? 'Google' : 'Anthropic';

      if (scope === 'default') {
        config.ANTHROPIC_MODEL = model;
        await interaction.reply({
          content: `Default model changed to **${modelLabel}** (${provider}). All new sessions will use this model.`,
          ephemeral: true,
        });
        return;
      }

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
        content: `This session is now using **${modelLabel}** (${provider}). Other sessions are unaffected.`,
        ephemeral: true,
      });
    },
  };
}
