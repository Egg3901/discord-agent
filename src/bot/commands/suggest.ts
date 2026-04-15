import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AIClient } from '../../claude/aiClient.js';
import { isAdmin } from '../middleware/permissions.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandler } from './types.js';
import type { GuildMember } from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { BotColors } from '../../utils/embedHelpers.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { rateLimitEmbed } from '../../utils/embedHelpers.js';
import { config } from '../../config.js';

// System prompt for code suggestions
const CODE_SUGGESTION_SYSTEM = `You are an expert code reviewer specializing in providing actionable suggestions for code improvements. 

Analyze the provided code changes and provide suggestions in the following categories:
1. Critical: Security vulnerabilities, potential bugs, major performance issues
2. High: Code quality, readability, maintainability improvements
3. Medium: Best practices, style consistency, minor optimizations
4. Low: Nitpicks, minor formatting issues

For each suggestion:
- Clearly explain the issue
- Provide a specific recommendation for improvement
- Include example code when relevant
- Prioritize suggestions by impact

Format your response as a structured list with priority levels clearly marked.`;

interface CodeSuggestion {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  issue: string;
  recommendation: string;
  codeExample?: string;
}

export function createSuggestCommand(
  aiClient: AIClient, 
  rateLimiter: RateLimiter,
  sessionManager: SessionManager
): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('suggest')
      .setDescription('Get intelligent code suggestions for improvements')
      .addStringOption((opt) =>
        opt
          .setName('code')
          .setDescription('Code to analyze (or omit to analyze session repo)')
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName('language')
          .setDescription('Language of the code (auto-detected if omitted)')
          .setRequired(false),
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAdmin(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'This command requires administrator permissions.',
          ephemeral: true,
        });
        return;
      }

      if (!rateLimiter.check(interaction.user.id)) {
        await interaction.reply({
          embeds: [rateLimitEmbed(rateLimiter.getInfo(interaction.user.id))],
          ephemeral: true,
        });
        return;
      }

      try {
        await interaction.deferReply();
        
        const code = interaction.options.getString('code');
        const language = interaction.options.getString('language');
        
        let codeToAnalyze = code;
        let sessionContext = '';
        
        // If no code provided, try to use session context
        if (!codeToAnalyze) {
          const session = sessionManager.getByThread(interaction.channelId);
          if (session && session.repoContext && session.repoContext.files.length > 0) {
            // Concatenate all files for analysis
            codeToAnalyze = session.repoContext.files
              .map((file: { path: string; content: string }) => `// File: ${file.path}\n${file.content}`)
              .join('\n\n');
            sessionContext = `Repository: ${session.repoContext.repoUrl}\n`;
          } else {
            await interaction.editReply({
              content: 'Please provide code to analyze or ensure you have an active session with a repository attached.',
            });
            return;
          }
        }

        // Create messages array with our code suggestion system prompt
        const messages = [
          {
            role: 'user' as const,
            content: `${CODE_SUGGESTION_SYSTEM}\n\nCode to analyze:\n\`\`\`${language || ''}\n${codeToAnalyze}\n\`\`\`\n\n${sessionContext}Please provide prioritized suggestions for improvement.`
          },
        ];

        // Get suggestions from the AI using the configured default model
        // so the command works regardless of which providers the operator has set up.
        const suggestions = await aiClient.getResponse(
          messages,
          {
            modelOverride: config.ANTHROPIC_MODEL,
            enableTools: false,
          }
        );

        // Split long responses into multiple embeds
        const maxEmbedLength = 4000;
        const embeds = [];
        
        if (suggestions.length <= maxEmbedLength) {
          const embed = new EmbedBuilder()
            .setColor(BotColors.Info)
            .setTitle('Code Suggestions')
            .setDescription(suggestions.substring(0, 4096));
          embeds.push(embed);
        } else {
          // Split into chunks
          const chunks = suggestions.match(/.{1,4000}/gs) || [];
          for (let i = 0; i < Math.min(chunks.length, 5); i++) { // Max 5 embeds
            const embed = new EmbedBuilder()
              .setColor(BotColors.Info)
              .setTitle(`Code Suggestions (Part ${i + 1})`)
              .setDescription(chunks[i]);
            embeds.push(embed);
          }
        }

        await interaction.editReply({ embeds });
      } catch (err) {
        logger.error({ err }, 'Error in /suggest command');
        await interaction.editReply({
          content: 'Sorry, I encountered an error while analyzing your code. Please try again.',
        });
      }
    },
  };
}