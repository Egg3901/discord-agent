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
import { AIClient, getProviderForModel } from '../../claude/aiClient.js';
import { ResponseStreamer } from '../../claude/responseFormatter.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { isAllowed } from '../middleware/permissions.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { ToolExecutor } from '../../tools/toolExecutor.js';
import { runAgentLoop } from '../../claude/agentLoop.js';
import { config } from '../../config.js';
import { logUsage } from '../../storage/database.js';
import { TOOL_EMOJIS, TOOL_LABELS, formatToolDetail, formatCCToolDetail } from '../../utils/toolDisplay.js';

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

    // Reject concurrent messages while a response is being generated
    if (session.busy) {
      await message.reply('Still working on the previous message. Please wait for it to finish (or react with 🛑 to cancel).');
      return;
    }

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

    try {
      await channel.sendTyping();

      session.busy = true;

      sessionManager.addMessage(threadId, {
        role: 'user',
        content,
      });

      // Create abort controller for this request
      const controller = new AbortController();
      session.activeController = controller;

      const thinkingMsg = await channel.send('Thinking...');
      const streamer = new ResponseStreamer(channel, thinkingMsg);

      // Periodic elapsed-time update so users know the bot is alive during long tasks.
      const thinkingStart = Date.now();
      const thinkingTimer = setInterval(() => {
        const secs = Math.round((Date.now() - thinkingStart) / 1000);
        thinkingMsg.edit(`Thinking... (${secs}s)`).catch(() => {});
      }, 15_000);

      try {
        const hasRepo = session.repoOwner && session.repoName;
        const hasWebSearch = config.ENABLE_WEB_SEARCH;
        const hasTools = hasRepo || config.ENABLE_SCRIPT_EXECUTION || config.ENABLE_DEV_TOOLS || hasWebSearch;

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
          customSystemPrompt: session.systemPrompt,
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

        if (isCC) {
          // Claude Code handles tools internally — stream events directly,
          // displaying tool notifications without re-executing them.
          const loopStart = Date.now();
          let fullResponse = '';
          let toolCallCount = 0;
          let detached = false;
          let lastToolMsg: import('discord.js').Message | null = null;
          for await (const event of aiClient.streamResponse(session.messages, baseStreamOptions)) {
            if (controller.signal.aborted) break;
            if (event.type === 'text') {
              // If tools were used, detach so the response appears as a new message
              if (toolCallCount > 0 && !detached) {
                detached = true;
                clearInterval(thinkingTimer);
                await streamer.detachForNewMessage(`*Used ${toolCallCount} tool(s)*`);
              }
              fullResponse += event.text;
              await streamer.push(event.text);
            } else if (event.type === 'tool_use') {
              // Mark previous tool as done when a new one starts
              if (lastToolMsg) {
                await lastToolMsg.edit(`${lastToolMsg.content} \u2014 \u2713`).catch(() => {});
              }
              toolCallCount++;
              const detail = formatCCToolDetail(event.name, event.input);
              lastToolMsg = await channel.send(`> \u{1F527} \`${event.name}\`${detail ? ` ${detail}` : ''}`);
            }
          }
          // Mark the last tool as done
          if (lastToolMsg) {
            await lastToolMsg.edit(`${lastToolMsg.content} \u2014 \u2713`).catch(() => {});
            lastToolMsg = null;
          }
          clearInterval(thinkingTimer);
          await streamer.finish();
          sessionManager.addMessage(threadId, { role: 'assistant', content: fullResponse });
          if (toolCallCount > 0) {
            const elapsed = ((Date.now() - loopStart) / 1000).toFixed(1);
            await channel.send(`<@${message.author.id}> Done \u2014 ${toolCallCount} tool call(s) in ${elapsed}s`).catch(() => {});
          }
        } else if (hasTools) {
          // Agentic mode for Anthropic / Gemini
          const toolExecutor = new ToolExecutor(
            hasRepo ? repoFetcher : null,
            session.repoOwner || '',
            session.repoName || '',
            session.id,
            session.repoContext?.repoUrl,
          );
          let lastToolMsg: import('discord.js').Message | null = null;
          let agentToolCount = 0;
          let agentDetached = false;
          const loopStart = Date.now();
          const result = await runAgentLoop(
            aiClient,
            session.messages,
            toolExecutor,
            { ...baseStreamOptions, enableRepoTools: !!hasRepo },
            {
              onTextChunk: async (text) => {
                // If tools were used, detach so the final response is a new message
                if (agentToolCount > 0 && !agentDetached) {
                  agentDetached = true;
                  clearInterval(thinkingTimer);
                  await streamer.detachForNewMessage(`*Used ${agentToolCount} tool(s)*`);
                }
                await streamer.push(text);
              },
              onToolStart: async (name, input) => {
                agentToolCount++;
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
            sessionManager.addMessage(threadId, msg);
          }
          if (result.toolCallCount > 0) {
            const elapsed = ((Date.now() - loopStart) / 1000).toFixed(1);
            logger.info({ sessionId: session.id, toolCalls: result.toolCallCount, iterations: result.iterations }, 'Agent loop completed');
            await channel.send(`<@${message.author.id}> Done \u2014 ${result.toolCallCount} tool call(s) in ${elapsed}s`).catch(() => {});
          }
        } else {
          // Simple streaming mode
          let fullResponse = '';
          for await (const chunk of aiClient.streamText(session.messages, baseStreamOptions)) {
            if (controller.signal.aborted) break;
            fullResponse += chunk;
            await streamer.push(chunk);
          }
          clearInterval(thinkingTimer);
          await streamer.finish();
          sessionManager.addMessage(threadId, { role: 'assistant', content: fullResponse });
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
      }
    } catch (err) {
      session.busy = false;
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

// Tool display formatting imported from ../../utils/toolDisplay.js
