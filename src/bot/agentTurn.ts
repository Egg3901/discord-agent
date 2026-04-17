import type { Message, DMChannel, ThreadChannel, TextChannel } from 'discord.js';
import { logger } from '../utils/logger.js';
import { formatApiError } from '../utils/errors.js';
import { SessionManager } from '../sessions/sessionManager.js';
import { AIClient, getProviderForModel } from '../claude/aiClient.js';
import { ResponseStreamer } from '../claude/responseFormatter.js';
import { RepoFetcher } from '../github/repoFetcher.js';
import { ToolExecutor } from '../tools/toolExecutor.js';
import { runAgentLoop } from '../claude/agentLoop.js';
import { config } from '../config.js';
import { logUsage } from '../storage/database.js';
import { TOOL_EMOJIS, TOOL_LABELS, formatToolDetail, formatCCToolDetail } from '../utils/toolDisplay.js';
import { sendCompletionWithNextSteps } from '../utils/nextSteps.js';
import type { Session } from '../sessions/session.js';

export type AgentTurnChannel = ThreadChannel | DMChannel | TextChannel;

export interface AgentTurnDeps {
  sessionManager: SessionManager;
  aiClient: AIClient;
  repoFetcher: RepoFetcher;
}

export interface AgentTurnInput {
  channel: AgentTurnChannel;
  userId: string;
  content: string;
  imageAttachments?: { mediaType: string; base64Data: string }[];
}

/**
 * Core agent-turn runner: appends the user message to the session,
 * streams the model response (with tool execution if applicable), and
 * sends completion/next-step buttons.
 *
 * Shared between `messageCreate` (real user messages) and the follow-up
 * buttons emitted by `sendCompletionWithNextSteps` so both paths drive
 * the model identically.
 *
 * Caller is responsible for admin/rate-limit/busy checks before invoking.
 */
export async function runAgentTurn(
  deps: AgentTurnDeps,
  session: Session,
  input: AgentTurnInput,
): Promise<void> {
  const { sessionManager, aiClient, repoFetcher } = deps;
  const { channel, userId, content, imageAttachments } = input;
  const threadId = session.threadId;

  try {
    await channel.sendTyping().catch(() => {});

    session.busy = true;

    sessionManager.addMessage(threadId, {
      role: 'user',
      content,
    });

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

      const onUsage = (usage: import('../claude/aiClient.js').UsageInfo) => {
        logUsage({
          userId,
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

      if (isCC) {
        const loopStart = Date.now();
        let fullResponse = '';
        let toolCallCount = 0;
        const toolNames: string[] = [];
        let detached = false;
        let lastToolMsg: Message | null = null;
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
        sessionManager.addMessage(threadId, { role: 'assistant', content: fullResponse });
        if (toolCallCount > 0) {
          await sendCompletionWithNextSteps(channel, userId, {
            toolNames,
            totalCalls: toolCallCount,
            elapsed: Date.now() - loopStart,
          });
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
        let lastToolMsg: Message | null = null;
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
            onToolStart: async (name, toolInput) => {
              agentToolCount++;
              agentToolNames.push(name);
              const emoji = TOOL_EMOJIS[name] || '\u{1F527}';
              const label = TOOL_LABELS[name] || name;
              const detail = formatToolDetail(name, toolInput);
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
          logger.info({ sessionId: session.id, toolCalls: result.toolCallCount, iterations: result.iterations }, 'Agent loop completed');
          await sendCompletionWithNextSteps(channel, userId, {
            toolNames: agentToolNames,
            totalCalls: result.toolCallCount,
            elapsed: Date.now() - loopStart,
          });
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
    logger.error({ err, threadId }, 'Error running agent turn');
  }
}
