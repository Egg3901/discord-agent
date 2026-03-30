import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AIClient } from '../../claude/aiClient.js';
import { isAllowed } from '../middleware/permissions.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';
import type { GuildMember } from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { BotColors } from '../../utils/embedHelpers.js';
import { config } from '../../config.js';

export function createContextCommand(sessionManager: SessionManager): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('context')
      .setDescription('View detailed session context and settings')
      .addStringOption((opt) =>
        opt
          .setName('scope')
          .setDescription('Scope of context to view')
          .setRequired(false)
          .addChoices(
            { name: 'Current session', value: 'session' },
            { name: 'Global settings', value: 'global' },
          ),
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
        await interaction.deferReply();
        
        const scope = interaction.options.getString('scope') || 'session';
        
        if (scope === 'global') {
          // Show global settings
          const embed = new EmbedBuilder()
            .setColor(BotColors.Info)
            .setTitle('Global Configuration')
            .addFields(
              { 
                name: 'Default Model', 
                value: `\`${config.ANTHROPIC_MODEL}\``, 
                inline: true 
              },
              { 
                name: 'Script Execution', 
                value: config.ENABLE_SCRIPT_EXECUTION ? '✅ Enabled' : '❌ Disabled', 
                inline: true 
              },
              { 
                name: 'Dev Tools', 
                value: config.ENABLE_DEV_TOOLS ? '✅ Enabled' : '❌ Disabled', 
                inline: true 
              },
              { 
                name: 'Web Search', 
                value: config.ENABLE_WEB_SEARCH ? '✅ Enabled' : '❌ Disabled', 
                inline: true 
              },
              { 
                name: 'Extended Thinking', 
                value: config.ENABLE_EXTENDED_THINKING ? '✅ Enabled' : '❌ Disabled', 
                inline: true 
              },
            );
          
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        // Show current session context
        const session = sessionManager.getByThread(interaction.channelId);
        
        if (!session) {
          await interaction.editReply({
            content: 'No active session in this thread. Use `/code` to start one.',
            ephemeral: true,
          });
          return;
        }

        // Build session context embed
        const fields = [];
        
        // Model information
        const model = session.modelOverride || config.ANTHROPIC_MODEL;
        fields.push({
          name: '🤖 Model',
          value: `\`${model}\``,
          inline: true
        });
        
        // Repository context
        if (session.repo) {
          fields.push({
            name: '📚 Repository',
            value: `[${session.repo.repoUrl}](${session.repo.repoUrl})\n${session.repo.files.length} files attached`,
            inline: true
          });
        } else {
          fields.push({
            name: '📚 Repository',
            value: 'None attached',
            inline: true
          });
        }
        
        // Tools status
        const tools = [];
        if (session.repo) tools.push('repo');
        if (config.ENABLE_SCRIPT_EXECUTION) tools.push('sandbox');
        if (config.ENABLE_DEV_TOOLS) tools.push('dev');
        if (config.ENABLE_WEB_SEARCH) tools.push('web');
        
        fields.push({
          name: '🛠️ Tools Available',
          value: tools.length > 0 ? tools.map(t => `\`${t}\``).join(', ') : 'None',
          inline: true
        });
        
        // Message history
        fields.push({
          name: '💬 Messages',
          value: `${session.messages.length} in history`,
          inline: true
        });
        
        // Token usage (if available)
        if (session.tokenUsage) {
          fields.push({
            name: '📊 Token Usage',
            value: `In: ${session.tokenUsage.tokensIn.toLocaleString()}\nOut: ${session.tokenUsage.tokensOut.toLocaleString()}`,
            inline: true
          });
        }
        
        // Custom persona
        if (session.persona) {
          fields.push({
            name: '👤 Persona',
            value: 'Custom persona active',
            inline: true
          });
        }

        const embed = new EmbedBuilder()
          .setColor(BotColors.Session)
          .setTitle(`Session Context - ${session.id.substring(0, 8)}`)
          .addFields(fields)
          .setFooter({ text: 'Use /repo, /model, /persona to modify session context' });

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        logger.error({ err }, 'Error in /context command');
        await interaction.editReply({
          content: 'Sorry, I encountered an error while retrieving session context. Please try again.',
        });
      }
    },
  };
}