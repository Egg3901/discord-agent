import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { isAllowed } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import type { CommandHandler } from './types.js';

export function createPersonaCommand(sessionManager: SessionManager): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('persona')
      .setDescription('Set a custom system prompt for this session')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set a custom system prompt prefix')
          .addStringOption((opt) =>
            opt
              .setName('text')
              .setDescription('Custom system prompt (e.g. "You are a senior Rust developer focused on performance")')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('clear').setDescription('Remove the custom system prompt'),
      )
      .addSubcommand((sub) =>
        sub.setName('show').setDescription('Show the current custom system prompt'),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      try {
        if (!isAllowed(interaction.member as GuildMember | null)) {
          await interaction.reply({ content: 'You do not have a role that allows using this bot.', ephemeral: true });
          return;
        }

        const session = sessionManager.getByThread(interaction.channelId);
        if (!session) {
          await interaction.reply({ content: 'No active session in this thread.', ephemeral: true });
          return;
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'set') {
          const text = interaction.options.getString('text', true);
          if (text.length > 4000) {
            await interaction.reply({ content: `Persona too long (${text.length} chars, max 4000).`, ephemeral: true });
            return;
          }
          session.systemPrompt = text;
          await interaction.reply({
            content: `Custom persona set for this session:\n> ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`,
            ephemeral: true,
          });
        } else if (subcommand === 'clear') {
          session.systemPrompt = undefined;
          await interaction.reply({ content: 'Custom persona cleared.', ephemeral: true });
        } else if (subcommand === 'show') {
          const prompt = session.systemPrompt;
          if (prompt) {
            await interaction.reply({ content: `Current persona:\n> ${prompt.slice(0, 500)}`, ephemeral: true });
          } else {
            await interaction.reply({ content: 'No custom persona set.', ephemeral: true });
          }
        }
      } catch (err) {
        await interaction.reply({ content: formatApiError(err), ephemeral: true }).catch(() => {});
      }
    },
  };
}
