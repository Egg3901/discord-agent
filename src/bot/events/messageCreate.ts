import {
  Client,
  Message,
  ChannelType,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { formatApiError } from '../../utils/errors.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AIClient } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { isAllowed } from '../middleware/permissions.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { ToolExecutor } from '../../tools/toolExecutor.js';
import { runAgentLoop } from '../../claude/agentLoop.js';
import { config } from '../../config.js';
import { logUsage } from '../../storage/database.js';

export function handleMessageCreate(
  client: Client,
  sessionManager: SessionManager,
  aiClient: AIClient,
  rateLimiter: RateLimiter,
  repoFetcher: RepoFetcher,
): void {
  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    if (
      message.channel.type !== ChannelType.PublicThread &&
      message.channel.type !== ChannelType.PrivateThread
    ) {
      return;
    }

    // Access check
    if (!isAllowed(message.member)) return;

    const threadId = message.channel.id;
    const session = sessionManager.getByThread(threadId);
    if (!session) return;

    if (!rateLimiter.check(message.author.id)) {
      await message.reply('You\'re sending messages too fast. Please wait a moment.');
      return;
    }

    const channel = message.channel as ThreadChannel;

    // Include file attachment contents in the message
    let content = message.content;
    if (message.attachments.size > 0) {
      for (const attachment of message.attachments.values()) {
        if (attachment.contentType?.startsWith('text/') || isCodeFile(attachment.name)) {
          try {
            const resp = await fetch(attachment.url);
            const text = await resp.text();
            if (text.length <= 100_000) {
              content += `\n\n--- ${attachment.name} ---\n\`\`\`\n${text}\n\`\`\``;
            } else {
              content += `\n\n[File ${attachment.name} too large to include (${Math.round(text.length / 1000)}KB)]`;
            }
          } catch {
            content += `\n\n[Could not read file: ${attachment.name}]`;
          }
        } else {
          content += `\n\n[Attached file: ${attachment.name} (${attachment.contentType || 'unknown type'})]`;
        }
      }
    }

    try {
      await channel.sendTyping();

      sessionManager.addMessage(threadId, {
        role: 'user',
        content,
      });

      const thinkingMsg = await channel.send('Thinking...');
      const streamer = new ResponseStreamer(channel, thinkingMsg);

      try {
        const hasRepo = session.repoOwner && session.repoName;
        const hasTools = hasRepo || config.ENABLE_SCRIPT_EXECUTION;

        const onUsage = (usage: import('../../claude/aiClient.js').UsageInfo) => {
          logUsage({
            userId: message.author.id,
            sessionId: session.id,
            keyId: usage.keyId,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            model: usage.model,
            costUsd: usage.costUsd,
          });
        };

        if (hasTools) {
          // Agentic mode: multi-step tool use loop
          const toolExecutor = new ToolExecutor(
            hasRepo ? repoFetcher : null,
            session.repoOwner || '',
            session.repoName || '',
            session.id,
          );
          const result = await runAgentLoop(
            aiClient,
            session.messages,
            toolExecutor,
            {
              repoContext: session.repoContext,
              modelOverride: session.modelOverride,
              enableRepoTools: !!hasRepo,
              onQueuePosition: (pos) => {
                thinkingMsg.edit(`In queue (position ${pos})...`).catch(() => {});
              },
              onUsage,
            },
            {
              onTextChunk: (text) => streamer.push(text),
              onToolStart: async (name, input) => {
                const inputSummary = Object.entries(input)
                  .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
                  .join(', ');
                await channel.send(`> \u{1F527} \`${name}\` ${inputSummary}`);
              },
              onToolEnd: async () => {
                // Tool completion is implicit — next iteration starts
              },
              onThinking: async () => {
                // Thinking indicator is handled by the ResponseStreamer animation
              },
            },
          );

          await streamer.finish();

          // Persist all new messages from the agent loop
          for (const msg of result.newMessages) {
            sessionManager.addMessage(threadId, msg);
          }

          if (result.toolCallCount > 0) {
            logger.info(
              { sessionId: session.id, toolCalls: result.toolCallCount, iterations: result.iterations },
              'Agent loop completed',
            );
          }
        } else {
          // Simple streaming mode (no repo attached)
          let fullResponse = '';
          for await (const chunk of aiClient.streamText(
            session.messages,
            {
              repoContext: session.repoContext,
              modelOverride: session.modelOverride,
              onQueuePosition: (pos) => {
                thinkingMsg.edit(`In queue (position ${pos})...`).catch(() => {});
              },
              onUsage,
            },
          )) {
            fullResponse += chunk;
            await streamer.push(chunk);
          }

          await streamer.finish();

          sessionManager.addMessage(threadId, {
            role: 'assistant',
            content: fullResponse,
          });
        }
      } catch (err) {
        logger.error({ err, sessionId: session.id }, 'Error streaming response');
        await streamer.sendError(formatApiError(err));
      }
    } catch (err) {
      logger.error({ err, threadId }, 'Error handling thread message');
    }
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
