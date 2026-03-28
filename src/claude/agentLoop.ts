import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { AIClient, ConversationMessage, ContentBlock, StreamOptions, AIStreamEvent, ToolUseEvent } from './aiClient.js';
import type { ToolExecutor } from '../tools/toolExecutor.js';

export interface AgentLoopCallbacks {
  onTextChunk: (text: string) => Promise<void>;
  onToolStart: (toolName: string, input: Record<string, unknown>) => Promise<void>;
  onToolEnd: (toolName: string, result: string) => Promise<void>;
  onThinking: () => Promise<void>;
  /** Called after each iteration with running totals (for progress display). */
  onProgress?: (iteration: number, toolCallCount: number, elapsedMs: number) => Promise<void>;
}

export interface AgentLoopResult {
  fullText: string;
  newMessages: ConversationMessage[];
  toolCallCount: number;
  iterations: number;
}

/**
 * Run a multi-step agent loop: stream AI response -> execute tool calls -> feed results back -> repeat.
 * Stops when the AI returns a final text response (stop_reason: end_turn) or max iterations reached.
 */
export async function runAgentLoop(
  aiClient: AIClient,
  messages: ConversationMessage[],
  toolExecutor: ToolExecutor,
  streamOptions: StreamOptions,
  callbacks: AgentLoopCallbacks,
): Promise<AgentLoopResult> {
  const maxIterations = config.MAX_AGENT_ITERATIONS;
  const newMessages: ConversationMessage[] = [];
  let totalText = '';
  let toolCallCount = 0;
  const loopStart = Date.now();

  // Work on a copy so we don't mutate the caller's array during the loop
  const workingMessages = [...messages];
  let previousToolKey = '';

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Collect events from the stream
    const textChunks: string[] = [];
    const toolUses: ToolUseEvent[] = [];
    let stopReason = 'end_turn';

    const stream = aiClient.streamResponse(workingMessages, {
      ...streamOptions,
      enableTools: true,
    });

    for await (const event of stream) {
      switch (event.type) {
        case 'text':
          textChunks.push(event.text);
          await callbacks.onTextChunk(event.text);
          break;
        case 'tool_use':
          toolUses.push(event);
          break;
        case 'thinking':
          await callbacks.onThinking();
          break;
        case 'stop':
          stopReason = event.stopReason;
          break;
      }
    }

    const iterationText = textChunks.join('');
    totalText += iterationText;

    // Build the assistant message content blocks
    const assistantBlocks: ContentBlock[] = [];
    if (iterationText) {
      assistantBlocks.push({ type: 'text', text: iterationText });
    }
    for (const tu of toolUses) {
      assistantBlocks.push({
        type: 'tool_use',
        id: tu.id,
        name: tu.name,
        input: tu.input,
      });
    }

    if (assistantBlocks.length > 0) {
      const assistantMsg: ConversationMessage = {
        role: 'assistant',
        content: assistantBlocks,
      };
      workingMessages.push(assistantMsg);
      newMessages.push(assistantMsg);
    }

    // If no tool calls, we're done (text-only response)
    if (toolUses.length === 0) {
      break;
    }

    // Stuck-loop detection: if exact same tool calls as previous iteration, bail.
    // Use sorted keys for stable comparison (JSON.stringify key order is non-deterministic).
    const currentToolKey = toolUses.map((t) => {
      const sortedInput = Object.keys(t.input).sort().map((k) => `${k}=${JSON.stringify(t.input[k])}`).join(',');
      return `${t.name}:{${sortedInput}}`;
    }).join('|');
    if (currentToolKey === previousToolKey) {
      logger.warn({ iteration, toolCalls: toolUses.map((t) => t.name) }, 'Agent loop: repeated tool calls detected, stopping');
      break;
    }
    previousToolKey = currentToolKey;

    // Execute tools and build tool_result blocks.
    // Run multiple tool calls in parallel for read-heavy operations (significant
    // speedup when the AI requests e.g. read_file + search_code simultaneously).
    const toolResultBlocks: ContentBlock[] = [];
    if (toolUses.length === 1) {
      // Single tool — execute directly (no parallelism overhead)
      const tu = toolUses[0];
      toolCallCount++;
      await callbacks.onToolStart(tu.name, tu.input);
      const result = await toolExecutor.execute(tu.name, tu.input);
      await callbacks.onToolEnd(tu.name, result);
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    } else {
      // Multiple tools — fire start callbacks, execute in parallel, then end callbacks
      for (const tu of toolUses) {
        toolCallCount++;
        await callbacks.onToolStart(tu.name, tu.input);
      }

      const results = await Promise.allSettled(
        toolUses.map((tu) => toolExecutor.execute(tu.name, tu.input)),
      );

      for (let i = 0; i < toolUses.length; i++) {
        const tu = toolUses[i];
        const settled = results[i];
        const result = settled.status === 'fulfilled'
          ? settled.value
          : `Error: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`;
        await callbacks.onToolEnd(tu.name, result);
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
      }
    }

    const toolResultMsg: ConversationMessage = {
      role: 'user',
      content: toolResultBlocks,
    };
    workingMessages.push(toolResultMsg);
    newMessages.push(toolResultMsg);

    logger.debug(
      { iteration, toolCalls: toolUses.map((t) => t.name), toolCallCount },
      'Agent loop iteration complete',
    );

    // Notify caller of progress so they can update the Discord message
    await callbacks.onProgress?.(iteration + 1, toolCallCount, Date.now() - loopStart);

    // Safety: if we're about to hit the max, ask the AI to wrap up
    if (iteration === maxIterations - 2) {
      workingMessages.push({
        role: 'user',
        content: '[System: You are approaching the tool-use iteration limit. Please provide your final answer now.]',
      });
      newMessages.push({
        role: 'user',
        content: '[System: You are approaching the tool-use iteration limit. Please provide your final answer now.]',
      });
    }
  }

  return {
    fullText: totalText,
    newMessages,
    toolCallCount,
    iterations: newMessages.filter((m) => m.role === 'assistant').length,
  };
}
