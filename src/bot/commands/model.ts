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
import { listOllamaModels, listOllamaLibrary, formatModelSize } from '../../claude/ollamaModels.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';

/**
 * Static cloud-provider models (always available — no live source to fetch).
 * Ollama entries are pulled live from ollama.com/search (see listOllamaLibrary)
 * and from the user's server (`/api/tags`). A tiny static fallback is kept at
 * the bottom in case both network paths fail.
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
 * Minimal Ollama fallback — only used when both listOllamaLibrary() and
 * listOllamaModels() return empty (e.g. offline bot host + no local server).
 */
const STATIC_OLLAMA_FALLBACK = [
  { name: 'Ollama: qwen2.5-coder 7b', value: 'ollama/qwen2.5-coder--7b' },
  { name: 'Ollama: llama3.2 3b', value: 'ollama/llama3.2--3b' },
];

/**
 * Cloud-only Ollama models (hosted on ollama.com; not pullable to local).
 * These require OLLAMA_BASE_URL=https://ollama.com and a valid OLLAMA_API_KEY.
 * Keep this list short and current — the `-cloud` tag is the canonical cloud
 * variant per the Ollama cloud docs.
 */
const CLOUD_ONLY_OLLAMA_MODELS = [
  { name: 'Ollama ☁: gpt-oss 120b', value: 'ollama/gpt-oss--120b-cloud' },
  { name: 'Ollama ☁: qwen3-coder 480b', value: 'ollama/qwen3-coder--480b-cloud' },
  { name: 'Ollama ☁: deepseek-v3.1 671b', value: 'ollama/deepseek-v3.1--671b-cloud' },
  { name: 'Ollama ☁: kimi-k2 1t', value: 'ollama/kimi-k2--1t-cloud' },
  { name: 'Ollama ☁: glm-4.6', value: 'ollama/glm-4.6--cloud' },
  { name: 'Ollama ☁: minimax-m2', value: 'ollama/minimax-m2--cloud' },
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
        // Dedupe by value. Priority: already-pulled > live library > cloud-only
        // curated > static fallback. Live sources run in parallel.
        const byValue = new Map<string, { name: string; value: string }>();
        const matches = (label: string, value: string) =>
          !focused ||
          label.toLowerCase().includes(focused) ||
          value.toLowerCase().includes(focused);

        const [ollamaModels, libraryModels] = await Promise.all([
          listOllamaModels(),
          listOllamaLibrary(),
        ]);

        // 1. Models already pulled / provisioned on the user's Ollama server.
        for (const m of ollamaModels) {
          const displayName = `Ollama: ${m.name} (${formatModelSize(m.size)})`;
          const value = encodeOllamaModelValue(m.name);
          if (matches(displayName, value)) {
            byValue.set(value, { name: displayName.slice(0, 100), value });
          }
        }

        // 2. Live library entries from ollama.com/search — one choice per
        //    size variant so users can pick the exact tag. Base ":latest" is
        //    emitted only when no sizes are advertised.
        for (const m of libraryModels) {
          const variants = m.sizes.length > 0 ? m.sizes : [''];
          for (const size of variants) {
            const tagged = size ? `${m.name}:${size}` : m.name;
            const value = encodeOllamaModelValue(tagged);
            if (byValue.has(value)) continue;
            const label = size
              ? `Ollama: ${m.name} ${size}${m.pulls ? ` • ${m.pulls} pulls` : ''}`
              : `Ollama: ${m.name}${m.pulls ? ` • ${m.pulls} pulls` : ''}`;
            if (matches(label, value)) {
              byValue.set(value, { name: label.slice(0, 100), value });
            }
          }
        }

        // 3. Cloud-only models (ollama.com-hosted). These aren't always
        //    present in /search scrape output and can't be pulled locally,
        //    so keep a curated short-list pinned here.
        for (const m of CLOUD_ONLY_OLLAMA_MODELS) {
          if (byValue.has(m.value)) continue;
          if (matches(m.name, m.value)) byValue.set(m.value, m);
        }

        // 4. Static cloud-provider models (Claude, Gemini, Claude Code).
        for (const m of STATIC_MODELS) {
          if (byValue.has(m.value)) continue;
          if (matches(m.name, m.value)) byValue.set(m.value, m);
        }

        // 5. Last-resort Ollama fallback if both live sources were empty.
        if (ollamaModels.length === 0 && libraryModels.length === 0) {
          for (const m of STATIC_OLLAMA_FALLBACK) {
            if (byValue.has(m.value)) continue;
            if (matches(m.name, m.value)) byValue.set(m.value, m);
          }
        }

        // Discord limits to 25 autocomplete results
        await interaction.respond([...byValue.values()].slice(0, 25));
      } catch (err) {
        logger.debug({ err }, 'Model autocomplete failed');
        // Fallback: static cloud providers + curated cloud-only Ollama list +
        // a tiny local Ollama fallback. No live network needed.
        const fallback = [...STATIC_MODELS, ...CLOUD_ONLY_OLLAMA_MODELS, ...STATIC_OLLAMA_FALLBACK]
          .filter((m) => !focused || m.name.toLowerCase().includes(focused) || m.value.toLowerCase().includes(focused));
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
        const staticMatch =
          STATIC_MODELS.find((m) => m.value === model) ||
          CLOUD_ONLY_OLLAMA_MODELS.find((m) => m.value === model) ||
          STATIC_OLLAMA_FALLBACK.find((m) => m.value === model);
        const modelLabel = staticMatch?.name ?? model.replace(/^ollama\//, '').replace(/--/g, ':');
        const isOllamaCloud = model.startsWith('ollama/') && /(^|[-:])cloud$/.test(model);
        const provider = model === 'claude-code' || model.startsWith('claude-code-')
          ? 'Claude Code'
          : model.startsWith('gemini-') ? 'Google'
          : isOllamaCloud ? 'Ollama Cloud'
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
