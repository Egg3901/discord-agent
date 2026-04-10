import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type GuildMember,
} from 'discord.js';
import { config } from '../../config.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { isAdmin } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import { listOllamaModels, formatModelSize } from '../../claude/ollamaModels.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';

/**
 * Static models from cloud providers (always available).
 * Ollama models are fetched dynamically from the server.
 */
const STATIC_MODELS = [
  // Claude Code (uses host's CLI login / Max plan, or pool API key)
  { name: 'Claude Code (default)', value: 'claude-code' },
  { name: 'Claude Code — Opus', value: 'claude-code-opus' },
  { name: 'Claude Code — Sonnet', value: 'claude-code-sonnet' },
  { name: 'Claude Code — Haiku', value: 'claude-code-haiku' },
  // Claude (Anthropic API)
  { name: 'Claude Opus 4.6', value: 'claude-opus-4-6' },
  { name: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { name: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  { name: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
  // Gemini (Google)
  { name: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
  { name: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
  { name: 'Gemini 2.0 Flash', value: 'gemini-2.0-flash' },
];

/**
 * Convert an Ollama model name (e.g. "qwen2.5-coder:32b") to the
 * value format used by getProviderForModel ("ollama/qwen2.5-coder--32b").
 * Colons are encoded as "--" because Discord choice values don't handle colons well.
 */
function encodeOllamaModelValue(name: string): string {
  return `ollama/${name.replace(/:/g, '--')}`;
}

export function createModelCommand(
  sessionManager: SessionManager,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('model')
      .setDescription('Switch the AI model (Claude, Gemini, or Ollama)')
      .addStringOption((opt) =>
        opt
          .setName('model')
          .setDescription('Model to use (type to search, Ollama models fetched live)')
          .setRequired(true)
          .setAutocomplete(true),
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

    async autocomplete(interaction: AutocompleteInteraction) {
      const focused = interaction.options.getFocused().toLowerCase();
      try {
        // Start with static models
        const choices: { name: string; value: string }[] = [];

        for (const m of STATIC_MODELS) {
          if (!focused || m.name.toLowerCase().includes(focused) || m.value.toLowerCase().includes(focused)) {
            choices.push(m);
          }
        }

        // Fetch Ollama models dynamically (with short timeout — non-blocking)
        const ollamaModels = await listOllamaModels();
        for (const m of ollamaModels) {
          const displayName = `Ollama: ${m.name} (${formatModelSize(m.size)})`;
          const value = encodeOllamaModelValue(m.name);
          if (!focused || displayName.toLowerCase().includes(focused) || m.name.toLowerCase().includes(focused)) {
            choices.push({ name: displayName.slice(0, 100), value });
          }
        }

        // Discord limits to 25 autocomplete results
        await interaction.respond(choices.slice(0, 25));
      } catch (err) {
        logger.debug({ err }, 'Model autocomplete failed');
        // Fallback to static models only
        const fallback = STATIC_MODELS.filter(
          (m) => !focused || m.name.toLowerCase().includes(focused) || m.value.toLowerCase().includes(focused),
        );
        await interaction.respond(fallback.slice(0, 25));
      }
    },

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAdmin(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'This command requires administrator permissions.',
          ephemeral: true,
        });
        return;
      }

      try {
        const model = interaction.options.getString('model', true);
        const scope = interaction.options.getString('scope') || 'session';

        // Build a human-readable label
        const staticMatch = STATIC_MODELS.find((m) => m.value === model);
        const modelLabel = staticMatch?.name ?? model.replace(/^ollama\//, '').replace(/--/g, ':');
        const provider = model === 'claude-code' || model.startsWith('claude-code-')
          ? 'Claude Code'
          : model.startsWith('gemini-') ? 'Google'
          : model.startsWith('ollama/') ? 'Ollama'
          : 'Anthropic';

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
      } catch (err) {
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
