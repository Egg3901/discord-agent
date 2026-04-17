import {
  Client,
  Message,
  ChannelType,
  type ThreadChannel,
  type DMChannel,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AIClient } from '../../claude/aiClient.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { isAdmin } from '../middleware/permissions.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { runAgentTurn } from '../agentTurn.js';

export function handleMessageCreate(
  client: Client,
  sessionManager: SessionManager,
  aiClient: AIClient,
  rateLimiter: RateLimiter,
  repoFetcher: RepoFetcher,
): void {
  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    const isDm = message.channel.type === ChannelType.DM;

    if (
      !isDm &&
      message.channel.type !== ChannelType.PublicThread &&
      message.channel.type !== ChannelType.PrivateThread
    ) {
      return;
    }

    // Access check — require admin permissions
    if (!isAdmin(message.member)) {
      if (isDm) {
        logger.debug({ userId: message.author.id }, 'DM message denied: user not on allowlist');
      }
      return;
    }

    const threadId = message.channel.id;
    const session = sessionManager.getByThread(threadId);
    if (!session) {
      // In DMs without an active session, ignore silently
      if (isDm) {
        logger.debug({ userId: message.author.id, channelId: threadId }, 'DM message ignored: no active session for this channel');
      }
      return;
    }

    // Reject concurrent messages while a response is being generated
    if (session.busy) {
      await message.reply('Still working on the previous message. Please wait for it to finish (or react with 🛑 to cancel).');
      return;
    }

    if (!rateLimiter.check(message.author.id)) {
      await message.reply('You\'re sending messages too fast. Please wait a moment.');
      return;
    }

    const channel = message.channel as ThreadChannel | DMChannel;

    // Include file attachment contents and images in the message
    let content = message.content;
    const imageAttachments: { mediaType: string; base64Data: string }[] = [];
    if (message.attachments.size > 0) {
      for (const attachment of message.attachments.values()) {
        if (attachment.contentType?.startsWith('image/') && attachment.size <= 5_242_880) {
          // Image attachment — base64 encode for vision
          try {
            const resp = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) });
            const buffer = Buffer.from(await resp.arrayBuffer());
            imageAttachments.push({
              mediaType: attachment.contentType,
              base64Data: buffer.toString('base64'),
            });
          } catch {
            content += `\n\n[Could not read image: ${attachment.name}]`;
          }
        } else if (attachment.contentType?.startsWith('text/') || isCodeFile(attachment.name)) {
          try {
            const resp = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) });
            const text = await resp.text();
            if (text.length <= 100_000) {
              content += `\n\n--- ${attachment.name} ---\n\`\`\`\n${text}\n\`\`\``;
            } else {
              content += `\n\n[File ${attachment.name} too large to include (${Math.round(text.length / 1000)}KB)]`;
            }
          } catch {
            content += `\n\n[Could not read file: ${attachment.name}]`;
          }
        } else if (attachment.contentType?.startsWith('image/')) {
          content += `\n\n[Image ${attachment.name} too large (${Math.round(attachment.size / 1_048_576)}MB, max 5MB)]`;
        } else {
          content += `\n\n[Attached file: ${attachment.name} (${attachment.contentType || 'unknown type'})]`;
        }
      }
    }

    // Auto-fetch raw GitHub/Gist URLs embedded in the message
    const urlPattern = /https?:\/\/(?:raw\.githubusercontent\.com|gist\.githubusercontent\.com)\/[^\s)>\]]+/g;
    const urls = content.match(urlPattern);
    if (urls && urls.length > 0) {
      for (const url of urls.slice(0, 3)) { // Max 3 URLs
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          if (resp.ok) {
            const text = await resp.text();
            if (text.length <= 100_000) {
              const filename = url.split('/').pop() || 'file';
              content += `\n\n--- ${filename} (from URL) ---\n\`\`\`\n${text}\n\`\`\``;
            } else {
              content += `\n\n[URL content too large: ${url}]`;
            }
          }
        } catch {
          content += `\n\n[Could not fetch: ${url}]`;
        }
      }
    }

    await runAgentTurn(
      { sessionManager, aiClient, repoFetcher },
      session,
      {
        channel,
        userId: message.author.id,
        content,
        imageAttachments,
      },
    );
  });
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb',
  '.cpp', '.c', '.h', '.hpp', '.cs', '.swift', '.kt', '.scala', '.sh',
  '.bash', '.zsh', '.sql', '.json', '.yaml', '.yml', '.toml', '.xml',
  '.html', '.css', '.scss', '.less', '.md', '.txt', '.env', '.cfg',
  '.ini', '.conf', '.dockerfile', '.tf', '.vue', '.svelte',
]);

function isCodeFile(name: string | null): boolean {
  if (!name) return false;
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}
