import { type ThreadChannel, type DMChannel, type Message } from 'discord.js';
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

export interface AgentTurnDeps {
  sessionManager: SessionManager;
  aiClient: AIClient;
  repoFetcher: RepoFetcher;
}

export interface AgentTurnInput {
  channel: ThreadChannel | DMChannel;
  session: Session;
  userId: string;
  content: string;
  imageAttachments?: { mediaType: string; base64Data: string }[];
  /** When true, the busy check is skipped and no reply is sent. Used for follow-ups from button clicks. */
  skipBusyReply?: boolean;
  /** Optional reply-capable message used to warn the user that the session is busy. */
  replyTarget?: Pick<Message, 'reply'>;
}

/**
 * Run a single agent turn for a session: record the user message, stream the
 * response, execute tools, and post the completion panel with next-step buttons.
 *
 * Returns true if a turn ran, false if it was skipped (busy / no session).
 */
export async function runAgentTurn(
  deps: AgentTurnDeps,
  input: AgentTurnInput,
): Promise<boolean> {
  const { sessionManager, aiClient, repoFetcher } = deps;
  const { channel, session, userId, content, imageAttachments = [], replyTarget } = input;

  if (session.busy) {
    if (replyTarget) {
      await replyTarget.reply('Still working on the previous message. Please wait for it to finish (or react with 🛑 to cancel).').catch(() => {});
    } else {
      await channel.send('Still working on the previous message. Please wait for it to finish.').catch(() => {});
    }
    return false;
  }

  try {
    await channel.sendTyping();
    session.busy = true;

    sessionManager.addMessage(session.threadId, {
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
      const hasRepo = !!(session.repoOwner && session.repoName);
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
        imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
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
        sessionManager.addMessage(session.threadId, { role: 'assistant', content: fullResponse });
        if (toolCallCount > 0) {
          await sendCompletionWithNextSteps(
            channel,
            userId,
            { toolNames, totalCalls: toolCallCount, elapsed: Date.now() - loopStart },
            async (prompt) => {
              await runAgentTurn(deps, { channel, session, userId, content: prompt });
            },
          );
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
          sessionManager.addMessage(session.threadId, msg);
        }
        if (result.toolCallCount > 0) {
          logger.info({ sessionId: session.id, toolCalls: result.toolCallCount, iterations: result.iterations }, 'Agent loop completed');
          await sendCompletionWithNextSteps(
            channel,
            userId,
            { toolNames: agentToolNames, totalCalls: result.toolCallCount, elapsed: Date.now() - loopStart },
            async (prompt) => {
              await runAgentTurn(deps, { channel, session, userId, content: prompt });
            },
          );
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
    }
  } catch (err) {
    session.busy = false;
    logger.error({ err, threadId: session.threadId }, 'Error handling agent turn');
  }

  return true;
}
