import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { isAllowed } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import { getProviderForModel } from '../../claude/aiClient.js';
import { config } from '../../config.js';
import type { CommandHandler } from './types.js';

function providerLabel(provider: string): string {
  switch (provider) {
    case 'claude-code': return 'Claude Code';
    case 'google': return 'Google';
    case 'ollama': return 'Ollama';
    default: return 'Anthropic';
  }
}

export function createStatusCommand(sessionManager: SessionManager): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show current session info and bot configuration'),

    async execute(interaction: ChatInputCommandInteraction) {
      try {
        if (!isAllowed(interaction.member as GuildMember | null)) {
          await interaction.reply({ content: 'You do not have a role that allows using this bot.', ephemeral: true });
          return;
        }

        const session = sessionManager.getByThread(interaction.channelId);

        // --- Global / bot-wide info (always shown) ---
        const defaultModel = config.ANTHROPIC_MODEL;
        const defaultProvider = getProviderForModel(defaultModel);

        const features: string[] = [];
        if (config.ENABLE_DEV_TOOLS) features.push('dev-tools');
        if (config.ENABLE_SCRIPT_EXECUTION) features.push('sandbox');
        if (config.ENABLE_EXTENDED_THINKING) features.push('thinking');
        if (config.ENABLE_WEB_SEARCH) features.push('web-search');

        const lines: string[] = [];

        if (session) {
          // --- Session-specific info ---
          const effectiveModel = session.modelOverride || defaultModel;
          const provider = getProviderForModel(effectiveModel);

          const thinkingEnabled = session.thinkingEnabled != null ? session.thinkingEnabled : config.ENABLE_EXTENDED_THINKING;
          const thinkingBudget = session.thinkingBudget || config.THINKING_BUDGET_TOKENS;

          const age = Math.round((Date.now() - session.createdAt) / 60000);
          const idle = Math.round((Date.now() - session.lastActiveAt) / 60000);

          lines.push(
            `**Session Status**`,
            ``,
            `**Model:** \`${effectiveModel}\` (${providerLabel(provider)})${session.modelOverride ? ' *(session override)*' : ''}`,
            session.repoOwner ? `**Repo:** ${session.repoOwner}/${session.repoName}` : '**Repo:** none',
            `**Thinking:** ${thinkingEnabled ? `on (${thinkingBudget} tokens)` : 'off'}`,
            `**Messages:** ${session.messages.length}`,
            `**Age:** ${age}m (idle ${idle}m)`,
            `**Session ID:** \`${session.id}\``,
          );

          // Show global defaults if they differ from session
          if (session.modelOverride && session.modelOverride !== defaultModel) {
            lines.push(``, `**Global default model:** \`${defaultModel}\` (${providerLabel(defaultProvider)})`);
          }
        } else {
          // --- No session — show global config ---
          lines.push(
            `**Bot Status** (no active session in this thread)`,
            ``,
            `**Default model:** \`${defaultModel}\` (${providerLabel(defaultProvider)})`,
            `**\`/ask\` uses:** \`${defaultModel}\` (${providerLabel(defaultProvider)})`,
          );
        }

        // Features section (always shown)
        lines.push(
          ``,
          `**Enabled features:** ${features.length > 0 ? features.map(f => `\`${f}\``).join(', ') : 'none'}`,
        );

        await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      } catch (err) {
        await interaction.reply({ content: formatApiError(err), ephemeral: true }).catch(() => {});
      }
    },
  };
}
