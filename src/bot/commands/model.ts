import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { config } from '../../config.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { isAllowed } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import type { CommandHandler } from './types.js';

const AVAILABLE_MODELS = [
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
  // Ollama (local)
  { name: 'Qwen 2.5 Coder 32B', value: 'ollama/qwen2.5-coder--32b' },
  { name: 'Qwen 2.5 Coder 14B', value: 'ollama/qwen2.5-coder--14b' },
  { name: 'Qwen 2.5 Coder 7B', value: 'ollama/qwen2.5-coder--7b' },
  { name: 'Qwen3 30B A3B', value: 'ollama/qwen3--30b-a3b' },
  { name: 'Qwen3 8B', value: 'ollama/qwen3--8b' },
  { name: 'DeepSeek Coder V2', value: 'ollama/deepseek-coder-v2' },
  { name: 'Llama 3.1 8B', value: 'ollama/llama3.1--8b' },
];

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
      if (!isAllowed(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'You do not have a role that allows using this bot.',
          ephemeral: true,
        });
        return;
      }

      try {
        const model = interaction.options.getString('model', true);
        const scope = interaction.options.getString('scope') || 'session';
        const modelLabel = AVAILABLE_MODELS.find((m) => m.value === model)?.name ?? model;
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
