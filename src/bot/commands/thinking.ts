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

export function createThinkingCommand(
  sessionManager: SessionManager,
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('thinking')
      .setDescription('Toggle extended thinking for this session')
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Enable or disable thinking')
          .setRequired(true)
          .addChoices(
            { name: 'on', value: 'on' },
            { name: 'off', value: 'off' },
            { name: 'reset (use global default)', value: 'reset' },
          ),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('budget')
          .setDescription('Thinking token budget (default: 10000)')
          .setRequired(false)
          .setMinValue(1024)
          .setMaxValue(128000),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAllowed(interaction.member as GuildMember | null, interaction.user.id)) {
        await interaction.reply({
          content: 'You do not have a role that allows using this bot.',
          ephemeral: true,
        });
        return;
      }

      try {
        const session = sessionManager.getByThread(interaction.channelId);
        if (!session) {
          await interaction.reply({
            content: 'No active session in this thread. Use `/code` to start one.',
            ephemeral: true,
          });
          return;
        }

        const mode = interaction.options.getString('mode', true);
        const budget = interaction.options.getInteger('budget');

        if (mode === 'reset') {
          session.thinkingEnabled = null;
          session.thinkingBudget = null;
          const globalStatus = config.ENABLE_EXTENDED_THINKING ? 'on' : 'off';
          await interaction.reply({
            content: `Thinking reset to global default (**${globalStatus}**, ${config.THINKING_BUDGET_TOKENS} tokens).`,
            ephemeral: true,
          });
          return;
        }

        const enabled = mode === 'on';
        session.thinkingEnabled = enabled;
        if (budget) {
          session.thinkingBudget = budget;
        }

        const effectiveBudget = budget || session.thinkingBudget || config.THINKING_BUDGET_TOKENS;
        await interaction.reply({
          content: enabled
            ? `Extended thinking **enabled** for this session (${effectiveBudget} token budget).`
            : `Extended thinking **disabled** for this session.`,
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
