import {
  SlashCommandBuilder,
  AttachmentBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { SessionManager } from '../../sessions/sessionManager.js';
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

      await interaction.editReply({
        content: `Session exported (${session.messages.length} messages).`,
        files: [attachment],
      });
    },
  };
}
