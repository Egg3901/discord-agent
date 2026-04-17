import {
  Client,
  Message,
  ChannelType,
  type TextChannel,
  type ThreadChannel,
  type DMChannel,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { formatApiError } from '../../utils/errors.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AIClient, getProviderForModel } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { isAdmin } from '../middleware/permissions.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { ToolExecutor } from '../../tools/toolExecutor.js';
import { runAgentLoop } from '../../claude/agentLoop.js';
import { config } from '../../config.js';
import { logUsage } from '../../storage/database.js';
import { TOOL_EMOJIS, TOOL_LABELS, formatToolDetail, formatCCToolDetail } from '../../utils/toolDisplay.js';
import { sendCompletionWithNextSteps } from '../../utils/nextSteps.js';
import type { Session } from '../../sessions/session.js';

export function handleMessageCreate(
  client: Client,
  sessionManager: SessionManager,
  aiClient: AIClient,
  rateLimiter: RateLimiter,
  repoFetcher: RepoFetcher,
): void {
  /**
   * Core agent runner — processes a single prompt within an active session.
   * After it finishes it drains the session's promptQueue automatically.
   */
  async function runForSession(
    session: Session,
    channel: ThreadChannel | DMChannel,
    content: string,
    authorId: string,
    imageAttachments?: { mediaType: string; base64Data: string }[],
  ): Promise<void> {
    session.busy = true;
    sessionManager.addMessage(session.threadId, { role: 'user', content });

    const controller = new AbortController();
    session.activeController = controller;

    const thinkingMsg = await channel.send('Thinking...');
    const streamer = new ResponseStreamer(channel, thinkingMsg);

    const thinkingStart = Date.now();
    const thinkingTimer = setInterval(() => {
      const secs = Math.round((Date.now() - thinkingStart) / 1000);
      thinkingMsg.edit(`Thinking... (${secs}s)`).catch(() => {});
    }, 15_000);

    try {
      const hasRepo = session.repoOwner && session.repoName;
      const hasSecondaryRepo = !!(session.secondaryRepoOwner && session.secondaryRepoName);
      const hasWebSearch = config.ENABLE_WEB_SEARCH;
      const hasTools = hasRepo || config.ENABLE_SCRIPT_EXECUTION || config.ENABLE_DEV_TOOLS || hasWebSearch;

      const onUsage = (usage: import('../../claude/aiClient.js').UsageInfo) => {
        logUsage({
          userId: authorId,
          sessionId: session.id,
          keyId: usage.keyId,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          model: usage.model,
          costUsd: usage.costUsd,
        });
      };

      const baseStreamOptions = {
        repoContext: session.repoContext,
        secondaryRepoContext: session.secondaryRepoContext,
        modelOverride: session.modelOverride,
        thinkingEnabled: session.thinkingEnabled,
        thinkingBudget: session.thinkingBudget,
        signal: controller.signal,
        imageAttachments: imageAttachments && imageAttachments.length > 0 ? imageAttachments : undefined,
        enableWebSearch: hasWebSearch,
        enableSecondaryRepo: hasSecondaryRepo,
        sessionId: session.id,
        customSystemPrompt: session.systemPrompt,
        sessionBaseBranch: session.defaultBranch,
        sessionSecondaryBaseBranch: session.secondaryDefaultBranch,
        onQueuePosition: (pos: number) => {
          thinkingMsg.edit(`In queue (position ${pos})...`).catch(() => {});
        },
        onStatus: (status: string) => {
          thinkingMsg.edit(status).catch(() => {});
        },
        onUsage,
      };

      const effectiveModel = session.modelOverride || config.ANTHROPIC_MODEL;
      const isCC = getProviderForModel(effectiveModel) === 'claude-code';

      // Callback passed to completion buttons so they bypass the bot-message filter
      const processPrompt = (prompt: string) => {
        session.promptQueue = session.promptQueue ?? [];
        session.promptQueue.push(prompt);
        if (!session.busy) {
          const next = session.promptQueue.shift()!;
          void runForSession(session, channel, next, session.userId);
        }
      };

      if (isCC) {
        const loopStart = Date.now();
        let fullResponse = '';
        let toolCallCount = 0;
        const toolNames: string[] = [];
        let detached = false;
        let lastToolMsg: import('discord.js').Message | null = null;
        for await (const event of aiClient.streamResponse(session.messages, baseStreamOptions)) {
          if (controller.signal.aborted) break;
          if (event.type === 'text') {
            if (toolCallCount > 0 && !detached) {
              detached = true;
              clearInterval(thinkingTimer);
              await streamer.detachForNewMessage(`*Used ${toolCallCount} tool(s)*`);
            }
            fullResponse += event.text;
            await streamer.push(event.text);
          } else if (event.type === 'tool_use') {
            if (lastToolMsg) {
              await lastToolMsg.edit(`${lastToolMsg.content} \u2014 \u2713`).catch(() => {});
            }
            toolCallCount++;
            toolNames.push(event.name);
            const detail = formatCCToolDetail(event.name, event.input);
            lastToolMsg = await channel.send(`> \u{1F527} \`${event.name}\`${detail ? ` ${detail}` : ''}`);
          }
        }
        if (lastToolMsg) {
          await lastToolMsg.edit(`${lastToolMsg.content} \u2014 \u2713`).catch(() => {});
          lastToolMsg = null;
        }
        clearInterval(thinkingTimer);
        await streamer.finish();
        sessionManager.addMessage(session.threadId, { role: 'assistant', content: fullResponse });
        if (toolCallCount > 0) {
          await sendCompletionWithNextSteps(channel, authorId, {
            toolNames,
            totalCalls: toolCallCount,
            elapsed: Date.now() - loopStart,
          }, processPrompt);
        }
      } else if (hasTools) {
        const toolExecutor = new ToolExecutor(
          hasRepo ? repoFetcher : null,
          session.repoOwner || '',
          session.repoName || '',
          session.id,
          session.repoContext?.repoUrl,
          session.defaultBranch,
        );
        if (hasSecondaryRepo) {
          toolExecutor.setSecondaryRepo(
            session.secondaryRepoOwner!,
            session.secondaryRepoName!,
            session.secondaryRepoContext?.repoUrl,
            session.secondaryDefaultBranch,
          );
        }
        let lastToolMsg: import('discord.js').Message | null = null;
        let agentToolCount = 0;
        const agentToolNames: string[] = [];
        let agentDetached = false;
        const loopStart = Date.now();
        const result = await runAgentLoop(
          aiClient,
          session.messages,
          toolExecutor,
          { ...baseStreamOptions, enableRepoTools: !!hasRepo, enableSecondaryRepo: hasSecondaryRepo },
          {
            onTextChunk: async (text) => {
              if (agentToolCount > 0 && !agentDetached) {
                agentDetached = true;
                clearInterval(thinkingTimer);
                await streamer.detachForNewMessage(`*Used ${agentToolCount} tool(s)*`);
              }
              await streamer.push(text);
            },
            onToolStart: async (name, input) => {
              agentToolCount++;
              agentToolNames.push(name);
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
            onProgress: async (_iter, tools, elapsed) => {
              const secs = Math.round(elapsed / 1000);
              thinkingMsg.edit(`Working... (${tools} tool call${tools !== 1 ? 's' : ''}, ${secs}s)`).catch(() => {});
            },
          },
        );
        clearInterval(thinkingTimer);
        await streamer.finish();
        for (const msg of result.newMessages) {
          sessionManager.addMessage(session.threadId, msg);
        }
        if (result.toolCallCount > 0) {
          logger.info({ sessionId: session.id, toolCalls: result.toolCallCount, iterations: result.iterations }, 'Agent loop completed');
          await sendCompletionWithNextSteps(channel, authorId, {
            toolNames: agentToolNames,
            totalCalls: result.toolCallCount,
            elapsed: Date.now() - loopStart,
          }, processPrompt);
        }
      } else {
        let fullResponse = '';
        for await (const chunk of aiClient.streamText(session.messages, baseStreamOptions)) {
          if (controller.signal.aborted) break;
          fullResponse += chunk;
          await streamer.push(chunk);
        }
        clearInterval(thinkingTimer);
        await streamer.finish();
        sessionManager.addMessage(session.threadId, { role: 'assistant', content: fullResponse });
      }
    } catch (err: any) {
      clearInterval(thinkingTimer);
      if (err?.name === 'AbortError') {
        await streamer.finish();
        await channel.send('*Cancelled.*');
      } else {
        logger.error({ err, sessionId: session.id }, 'Error streaming response');
        await streamer.sendError(formatApiError(err));
      }
    } finally {
      clearInterval(thinkingTimer);
      session.activeController = undefined;
      session.busy = false;

      // Drain the next queued prompt if any
      const next = session.promptQueue?.shift();
      if (next) {
        void runForSession(session, channel, next, session.userId);
      }
    }
  }

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

    if (!isAdmin(message.member)) {
      if (isDm) {
        logger.debug({ userId: message.author.id }, 'DM message denied: user not on allowlist');
      }
      return;
    }

    const threadId = message.channel.id;
    const session = sessionManager.getByThread(threadId);
    if (!session) {
      if (isDm) {
        logger.debug({ userId: message.author.id, channelId: threadId }, 'DM message ignored: no active session for this channel');
      }
      return;
    }

    // Build message content (attachments + raw GitHub URLs)
    let content = message.content;
    const imageAttachments: { mediaType: string; base64Data: string }[] = [];
    if (message.attachments.size > 0) {
      for (const attachment of message.attachments.values()) {
        if (attachment.contentType?.startsWith('image/') && attachment.size <= 5_242_880) {
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

    const urlPattern = /https?:\/\/(?:raw\.githubusercontent\.com|gist\.githubusercontent\.com)\/[^\s)>\]]+/g;
    const urls = content.match(urlPattern);
    if (urls && urls.length > 0) {
      for (const url of urls.slice(0, 3)) {
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

    // If session is busy, queue the message silently and react with a clock
    if (session.busy) {
      session.promptQueue = session.promptQueue ?? [];
      session.promptQueue.push(content);
      await message.react('⏳').catch(() => {});
      return;
    }

    if (!rateLimiter.check(message.author.id)) {
      await message.reply('You\'re sending messages too fast. Please wait a moment.');
      return;
    }

    const channel = message.channel as ThreadChannel | DMChannel;

    try {
      await channel.sendTyping();
      void runForSession(session, channel, content, message.author.id, imageAttachments);
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
