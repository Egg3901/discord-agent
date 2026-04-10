import {
  SlashCommandBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { isAdmin } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import { BotColors, formatDuration } from '../../utils/embedHelpers.js';
import type { CommandHandler } from './types.js';
import type { ConversationMessage, ContentBlock } from '../../claude/aiClient.js';

function messageToMarkdown(msg: ConversationMessage, index: number): string {
  const role = msg.role === 'user' ? '**User**' : '**Assistant**';
  let content: string;

  if (typeof msg.content === 'string') {
    content = msg.content;
  } else {
    const blocks = msg.content as ContentBlock[];
    const parts: string[] = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        parts.push(block.text);
      } else if (block.type === 'tool_use') {
        const inputStr = JSON.stringify(block.input, null, 2);
        parts.push(`> 🔧 **Tool call:** \`${block.name}\`\n> \`\`\`json\n${inputStr}\n\`\`\``);
      } else if (block.type === 'tool_result') {
        const preview = block.content.slice(0, 300);
        const truncated = block.content.length > 300 ? '…' : '';
        parts.push(`> ↩️ **Tool result:**\n> \`\`\`\n${preview}${truncated}\n\`\`\``);
      }
    }
    content = parts.join('\n\n');
  }

  return `### Message ${index + 1} — ${role}\n\n${content}`;
}

export function createExportCommand(sessionManager: SessionManager): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('export')
      .setDescription('Export this session conversation as a markdown file'),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAdmin(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'This command requires administrator permissions.',
          ephemeral: true,
        });
        return;
      }

      const threadId = interaction.channelId;
      const session = sessionManager.getByThread(threadId);

      if (!session) {
        await interaction.reply({
          content: 'No active session in this thread.',
          ephemeral: true,
        });
        return;
      }

      if (session.messages.length === 0) {
        await interaction.reply({
          content: 'No messages to export yet.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const header = [
          `# Session Export`,
          ``,
          `- **Session ID:** ${session.id}`,
          `- **Thread:** <#${session.threadId}>`,
          `- **Started:** ${new Date(session.createdAt).toISOString()}`,
          `- **Messages:** ${session.messages.length}`,
          session.repoContext ? `- **Repo:** ${session.repoContext.repoUrl}` : null,
          session.modelOverride ? `- **Model:** ${session.modelOverride}` : null,
          ``,
          `---`,
          ``,
        ].filter(Boolean).join('\n');

        const body = session.messages
          .map((msg, i) => messageToMarkdown(msg, i))
          .join('\n\n---\n\n');

        const markdown = header + body;
        const buffer = Buffer.from(markdown, 'utf-8');
        const filename = `session-${session.id}-${Date.now()}.md`;
        const attachment = new AttachmentBuilder(buffer, { name: filename });

        const fileSizeKB = (buffer.length / 1024).toFixed(1);
        const sessionAge = formatDuration(Date.now() - session.createdAt);

        const exportEmbed = new EmbedBuilder()
          .setColor(BotColors.Success)
          .setTitle('Session Exported')
          .addFields(
            { name: 'Messages', value: `${session.messages.length}`, inline: true },
            { name: 'File Size', value: `${fileSizeKB} KB`, inline: true },
            { name: 'Session Age', value: sessionAge, inline: true },
          )
          .setTimestamp();

        await interaction.editReply({
          embeds: [exportEmbed],
          files: [attachment],
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
