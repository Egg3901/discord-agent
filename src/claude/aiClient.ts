import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { KeyPool } from '../keys/keyPool.js';
import { buildSystemPrompt, trimConversation, type RepoContext } from './contextBuilder.js';
import { AGENT_TOOLS, SANDBOX_TOOLS, toGeminiFunctionDeclarations } from '../tools/toolDefinitions.js';
import type { Provider } from '../keys/types.js';

// --- Content block types (provider-agnostic) ---

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// --- Stream event types ---

export interface TextChunkEvent {
  type: 'text';
  text: string;
}

export interface ToolUseEvent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingEvent {
  type: 'thinking';
}

export interface StopEvent {
  type: 'stop';
  stopReason: string;
}

export type AIStreamEvent = TextChunkEvent | ToolUseEvent | ThinkingEvent | StopEvent;

export interface StreamOptions {
  repoContext?: RepoContext;
  modelOverride?: string;
  onQueuePosition?: (position: number) => void;
  enableTools?: boolean;
  enableRepoTools?: boolean;
}

/**
 * Model-to-provider mapping.
 */
const GOOGLE_MODEL_PREFIXES = ['gemini-'];

export function getProviderForModel(model: string): Provider {
  if (GOOGLE_MODEL_PREFIXES.some((p) => model.startsWith(p))) {
    return 'google';
  }
  return 'anthropic';
}

/**
 * Build the tool list based on what's available (repo tools, script tool).
 */
function getActiveTools(options: StreamOptions): import('../tools/toolDefinitions.js').ToolDefinition[] {
  const tools = [];
  if (options.enableRepoTools) {
    tools.push(...AGENT_TOOLS);
  }
  if (config.ENABLE_SCRIPT_EXECUTION) {
    tools.push(...SANDBOX_TOOLS);
  }
  return tools;
}

export class AIClient {
  constructor(private keyPool: KeyPool) {}

  /**
   * Stream structured events (text, tool_use, thinking, stop).
   */
  async *streamResponse(
    messages: ConversationMessage[],
    options: StreamOptions = {},
  ): AsyncGenerator<AIStreamEvent> {
    const model = options.modelOverride || config.ANTHROPIC_MODEL;
    const provider = getProviderForModel(model);

    if (provider === 'google') {
      yield* this.streamGemini(messages, model, options);
    } else {
      yield* this.streamAnthropic(messages, model, options);
    }
  }

  /**
   * Convenience: stream only text chunks (for simple non-agentic use like /ask).
   */
  async *streamText(
    messages: ConversationMessage[],
    options: StreamOptions = {},
  ): AsyncGenerator<string> {
    for await (const event of this.streamResponse(messages, options)) {
      if (event.type === 'text') {
        yield event.text;
      }
    }
  }

  async getResponse(
    messages: ConversationMessage[],
    options: StreamOptions = {},
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of this.streamText(messages, options)) {
      chunks.push(chunk);
    }
    return chunks.join('');
  }

  // --- Anthropic (Claude) ---

  private async *streamAnthropic(
    messages: ConversationMessage[],
    model: string,
    options: StreamOptions,
  ): AsyncGenerator<AIStreamEvent> {
    const systemPrompt = buildSystemPrompt(options.repoContext, options.enableRepoTools, config.ENABLE_SCRIPT_EXECUTION);
    const trimmed = trimConversation(messages, config.MAX_CONTEXT_TOKENS);

    // Convert messages to Anthropic format
    const anthropicMessages = trimmed.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content as any, // Anthropic SDK accepts string | ContentBlock[]
    }));

    const { key, release } = await this.keyPool.acquire('anthropic', options.onQueuePosition);

    try {
      const client = new Anthropic({ apiKey: key.apiKey });
      logger.debug({ model, keyId: key.id, provider: 'anthropic' }, 'Starting stream');

      const useThinking = config.ENABLE_EXTENDED_THINKING;
      const params: Record<string, any> = {
        model,
        max_tokens: useThinking ? config.THINKING_BUDGET_TOKENS + 16384 : 16384,
        system: systemPrompt,
        messages: anthropicMessages,
        stream: true,
      };

      if (options.enableTools) {
        const tools = getActiveTools(options);
        if (tools.length > 0) {
          params.tools = tools;
        }
      }

      if (useThinking) {
        params.thinking = {
          type: 'enabled',
          budget_tokens: config.THINKING_BUDGET_TOKENS,
        };
      }

      const stream = await client.messages.create(params as any);

      // Accumulate tool_use input JSON across deltas
      let currentToolId = '';
      let currentToolName = '';
      let toolInputJson = '';

      for await (const event of stream as any) {
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            toolInputJson = '';
          } else if (event.content_block?.type === 'thinking') {
            yield { type: 'thinking' } as ThinkingEvent;
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text } as TextChunkEvent;
          } else if (event.delta?.type === 'input_json_delta') {
            toolInputJson += event.delta.partial_json;
          }
          // thinking_delta — we emit a single 'thinking' event at block start, ignore deltas
        } else if (event.type === 'content_block_stop') {
          if (currentToolId && currentToolName) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(toolInputJson || '{}');
            } catch {
              logger.warn({ toolInputJson }, 'Failed to parse tool input JSON');
            }
            yield {
              type: 'tool_use',
              id: currentToolId,
              name: currentToolName,
              input,
            } as ToolUseEvent;
            currentToolId = '';
            currentToolName = '';
            toolInputJson = '';
          }
        } else if (event.type === 'message_delta') {
          yield {
            type: 'stop',
            stopReason: event.delta?.stop_reason || 'end_turn',
          } as StopEvent;
        }
      }

      release(true);
    } catch (err) {
      logger.error({ err, keyId: key.id, model }, 'Anthropic API error');
      release(false);
      throw err;
    }
  }

  // --- Google (Gemini) ---

  private async *streamGemini(
    messages: ConversationMessage[],
    model: string,
    options: StreamOptions,
  ): AsyncGenerator<AIStreamEvent> {
    const systemPrompt = buildSystemPrompt(options.repoContext, options.enableRepoTools, config.ENABLE_SCRIPT_EXECUTION);
    const trimmed = trimConversation(messages, config.MAX_CONTEXT_TOKENS);

    const { key, release } = await this.keyPool.acquire('google', options.onQueuePosition);

    try {
      const genai = new GoogleGenAI({ apiKey: key.apiKey });
      logger.debug({ model, keyId: key.id, provider: 'google' }, 'Starting stream');

      // Convert messages to Gemini format with proper function call/result parts
      const geminiContents = toGeminiContents(trimmed);

      const geminiConfig: Record<string, any> = {
        systemInstruction: systemPrompt,
        maxOutputTokens: 16384,
      };

      if (options.enableTools) {
        const tools = getActiveTools(options);
        if (tools.length > 0) {
          geminiConfig.tools = [{ functionDeclarations: toGeminiFunctionDeclarations(tools) }];
        }
      }

      if (config.ENABLE_EXTENDED_THINKING) {
        geminiConfig.thinkingConfig = {
          thinkingBudget: config.THINKING_BUDGET_TOKENS,
        };
      }

      const response = await genai.models.generateContentStream({
        model,
        contents: geminiContents,
        config: geminiConfig,
      });

      let hasToolCalls = false;
      for await (const chunk of response) {
        // Gemini may return function calls
        const parts = (chunk as any).candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.functionCall) {
            hasToolCalls = true;
            yield {
              type: 'tool_use',
              id: `gemini-${nanoid(12)}`,
              name: part.functionCall.name,
              input: part.functionCall.args || {},
            } as ToolUseEvent;
          } else if (part.text) {
            yield { type: 'text', text: part.text } as TextChunkEvent;
          }
        }
      }

      yield { type: 'stop', stopReason: hasToolCalls ? 'tool_use' : 'end_turn' } as StopEvent;
      release(true);
    } catch (err) {
      logger.error({ err, keyId: key.id, model }, 'Gemini API error');
      release(false);
      throw err;
    }
  }
}

/**
 * Convert conversation messages to Gemini content format.
 * Handles function call/result blocks properly instead of flattening to text.
 */
function toGeminiContents(
  messages: { role: 'user' | 'assistant'; content: string | ContentBlock[] }[],
): { role: 'user' | 'model'; parts: any[] }[] {
  const contents: { role: 'user' | 'model'; parts: any[] }[] = [];

  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' as const : 'user' as const;

    if (typeof m.content === 'string') {
      contents.push({ role, parts: [{ text: m.content }] });
      continue;
    }

    // Convert content blocks to Gemini parts
    const parts: any[] = [];
    for (const block of m.content) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        // Assistant's function call → Gemini functionCall part
        parts.push({
          functionCall: {
            name: block.name,
            args: block.input,
          },
        });
      } else if (block.type === 'tool_result') {
        // User's function result → Gemini functionResponse part
        // Find the matching tool_use to get the function name
        const toolName = findToolName(messages, block.tool_use_id);
        parts.push({
          functionResponse: {
            name: toolName || 'unknown',
            response: { result: block.content },
          },
        });
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return contents;
}

/**
 * Find the tool name for a given tool_use_id by searching previous messages.
 */
function findToolName(
  messages: { role: 'user' | 'assistant'; content: string | ContentBlock[] }[],
  toolUseId: string,
): string | undefined {
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_use' && block.id === toolUseId) {
        return block.name;
      }
    }
  }
  return undefined;
}
