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

    // Include file attachment contents and images in the message
    let content = message.content;
    const imageAttachments: { mediaType: string; base64Data: string }[] = [];
    if (message.attachments.size > 0) {
      for (const attachment of message.attachments.values()) {
        if (attachment.contentType?.startsWith('image/') && attachment.size <= 5_242_880) {
          // Image attachment — base64 encode for vision
          try {
            const resp = await fetch(attachment.url);
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
        } else if (attachment.contentType?.startsWith('image/')) {
          content += `\n\n[Image ${attachment.name} too large (${Math.round(attachment.size / 1_048_576)}MB, max 5MB)]`;
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

      // Create abort controller for this request
      const controller = new AbortController();
      session.activeController = controller;

      const thinkingMsg = await channel.send('Thinking...');
      const streamer = new ResponseStreamer(channel, thinkingMsg);

      try {
        const hasRepo = session.repoOwner && session.repoName;
        const hasWebSearch = config.ENABLE_WEB_SEARCH;
        const hasTools = hasRepo || config.ENABLE_SCRIPT_EXECUTION || hasWebSearch;

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

        // Common stream options with thinking overrides and abort signal
        const baseStreamOptions = {
          repoContext: session.repoContext,
          modelOverride: session.modelOverride,
          thinkingEnabled: session.thinkingEnabled,
          thinkingBudget: session.thinkingBudget,
          signal: controller.signal,
          imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
          enableWebSearch: hasWebSearch,
          sessionId: session.id,
          onQueuePosition: (pos: number) => {
            thinkingMsg.edit(`In queue (position ${pos})...`).catch(() => {});
          },
          onUsage,
        };

        if (hasTools) {
          // Agentic mode: multi-step tool use loop
          const toolExecutor = new ToolExecutor(
            hasRepo ? repoFetcher : null,
            session.repoOwner || '',
            session.repoName || '',
            session.id,
          );
          let lastToolMsg: import('discord.js').Message | null = null;
          const loopStart = Date.now();
          const result = await runAgentLoop(
            aiClient,
            session.messages,
            toolExecutor,
            {
              ...baseStreamOptions,
              enableRepoTools: !!hasRepo,
            },
            {
              onTextChunk: (text) => streamer.push(text),
              onToolStart: async (name, input) => {
                const emoji = TOOL_EMOJIS[name] || '\u{1F527}';
                const label = TOOL_LABELS[name] || name;
                const detail = formatToolDetail(name, input);
                lastToolMsg = await channel.send(`> ${emoji} ${label}${detail ? ` ${detail}` : ''}`);
              },
              onToolEnd: async (_name, toolResult) => {
                if (!lastToolMsg) return;
                const summary = toolResult.startsWith('Error:')
                  ? '\u274C'
                  : `\u2713 ${toolResult.split('\n')[0].trim().slice(0, 80)}`;
                await lastToolMsg.edit(`${lastToolMsg.content} \u2014 ${summary}`).catch(() => {});
                lastToolMsg = null;
              },
              onThinking: async () => {},
            },
          );

          await streamer.finish();

          // Persist all new messages from the agent loop
          for (const msg of result.newMessages) {
            sessionManager.addMessage(threadId, msg);
          }

          if (result.toolCallCount > 0) {
            const elapsed = ((Date.now() - loopStart) / 1000).toFixed(1);
            logger.info(
              { sessionId: session.id, toolCalls: result.toolCallCount, iterations: result.iterations },
              'Agent loop completed',
            );
            // Ping user so they know the multi-step task is done
            await channel.send(`<@${message.author.id}> Done \u2014 ${result.toolCallCount} tool call(s) in ${elapsed}s`).catch(() => {});
          }
        } else {
          // Simple streaming mode (no repo attached)
          let fullResponse = '';
          for await (const chunk of aiClient.streamText(session.messages, baseStreamOptions)) {
            if (controller.signal.aborted) break;
            fullResponse += chunk;
            await streamer.push(chunk);
          }

          await streamer.finish();

          sessionManager.addMessage(threadId, {
            role: 'assistant',
            content: fullResponse,
          });
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          await streamer.finish();
          await channel.send('*Cancelled.*');
        } else {
          logger.error({ err, sessionId: session.id }, 'Error streaming response');
          await streamer.sendError(formatApiError(err));
        }
      } finally {
        session.activeController = undefined;
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

// --- Tool display formatting ---

const TOOL_EMOJIS: Record<string, string> = {
  read_file: '\u{1F4C4}',
  list_directory: '\u{1F4C2}',
  search_code: '\u{1F50D}',
  run_script: '\u{25B6}\uFE0F',
  write_file: '\u{1F4DD}',
  read_local_file: '\u{1F4C4}',
  list_workspace: '\u{1F4C2}',
  run_terminal: '\u{1F4BB}',
  git_command: '\u{1F500}',
  build_project: '\u{1F3D7}\uFE0F',
  web_search: '\u{1F310}',
  web_fetch: '\u{1F310}',
};

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Reading',
  list_directory: 'Listing',
  search_code: 'Searching',
  run_script: 'Running script',
  write_file: 'Writing',
  read_local_file: 'Reading',
  list_workspace: 'Listing workspace',
  run_terminal: 'Running',
  git_command: 'Git',
  build_project: 'Building',
  web_search: 'Searching web',
  web_fetch: 'Fetching',
};

function formatToolDetail(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
    case 'read_local_file':
    case 'write_file':
      return input.path ? `\`${String(input.path)}\`` : '';
    case 'list_directory':
    case 'list_workspace':
      return input.path ? `\`${String(input.path) || '/'}\`` : '`/`';
    case 'search_code':
      return input.query ? `for \`${String(input.query).slice(0, 60)}\`` : '';
    case 'run_script':
      return input.language ? `(${String(input.language)})` : '';
    case 'run_terminal':
      return input.command ? `\`${String(input.command).slice(0, 80)}\`` : '';
    case 'git_command':
      return input.args ? `\`git ${String(input.args).slice(0, 80)}\`` : '';
    case 'build_project':
      return input.action ? `(${String(input.action)})` : '';
    case 'web_search':
      return input.query ? `\`${String(input.query).slice(0, 60)}\`` : '';
    case 'web_fetch':
      return input.url ? `\`${String(input.url).slice(0, 80)}\`` : '';
    default:
      return '';
  }
}
