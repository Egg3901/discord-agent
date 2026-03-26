import type {
  ChatInputCommandInteraction,
  SharedSlashCommand,
} from 'discord.js';

export interface CommandHandler {
  data: SharedSlashCommand;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
