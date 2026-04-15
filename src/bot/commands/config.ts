import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config } from '../../config.js';
import { isAdmin } from '../middleware/permissions.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';

export function createConfigCommand(): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('config')
      .setDescription('Set bot configuration values (admin only)')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set a configuration value (value is never displayed back)')
          .addStringOption((opt) =>
            opt
              .setName('key')
              .setDescription('Config key to set')
              .setRequired(true)
              .addChoices(
                ...config.listSettableKeys().map((k) => {
                  // Discord choice names are limited to 100 characters.
                  const full = `${k.key} — ${k.description}`;
                  return {
                    name: full.length > 100 ? `${full.slice(0, 97)}...` : full,
                    value: k.key,
                  };
                }),
              ),
          )
          .addStringOption((opt) =>
            opt
              .setName('value')
              .setDescription('New value (will not be echoed back)')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List all settable configuration keys'),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAdmin(interaction.member as import('discord.js').GuildMember | null)) {
        await interaction.reply({
          content: 'You do not have permission to use this command.',
          ephemeral: true,
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'set') {
        const key = interaction.options.getString('key', true);
        const value = interaction.options.getString('value', true);

        const result = config.set(key, value);

        if (result.success) {
          logger.info({ key, userId: interaction.user.id }, 'Config updated via command');
          await interaction.reply({
            content: `\`${key}\` updated successfully. Value is not displayed for security.`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: result.error!,
            ephemeral: true,
          });
        }
      }

      if (subcommand === 'list') {
        const keys = config.listSettableKeys();
        const lines = keys.map(
          (k) => `• \`${k.key}\` *(${k.type})* — ${k.description}`,
        );
        await interaction.reply({
          content: `**Settable config keys:**\n${lines.join('\n')}\n\nUse \`/config set <key> <value>\` to change. Values are never displayed.`,
          ephemeral: true,
        });
      }
    },
  };
}
