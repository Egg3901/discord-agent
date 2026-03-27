import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { spawn, type ChildProcess } from 'node:child_process';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { KeyPool } from '../keys/keyPool.js';
import { buildSystemPrompt, trimConversation, type RepoContext } from './contextBuilder.js';
import { AGENT_TOOLS, SANDBOX_TOOLS, DEV_TOOLS, toGeminiFunctionDeclarations } from '../tools/toolDefinitions.js';
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

export interface UsageInfo {
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  model: string;
  keyId: string;
}

export interface StreamOptions {
  repoContext?: RepoContext;
  modelOverride?: string;
  onQueuePosition?: (position: number) => void;
  enableTools?: boolean;
  enableRepoTools?: boolean;
  /** Called when usage info is available after a response completes */
  onUsage?: (usage: UsageInfo) => void;
}

/**
 * Model-to-provider mapping.
 */
const GOOGLE_MODEL_PREFIXES = ['gemini-'];
const CLAUDE_CODE_MODEL = 'claude-code';

export function getProviderForModel(model: string): Provider {
  if (model === CLAUDE_CODE_MODEL || model.startsWith('claude-code-')) {
    return 'claude-code';
  }
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
  if (config.ENABLE_DEV_TOOLS) {
    tools.push(...DEV_TOOLS);
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

    if (provider === 'claude-code') {
      yield* this.streamClaudeCode(messages, model, options);
    } else if (provider === 'google') {
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
    const systemPrompt = buildSystemPrompt(options.repoContext, options.enableRepoTools, config.ENABLE_SCRIPT_EXECUTION, config.ENABLE_DEV_TOOLS);
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

      // Track usage
      let inputTokens = 0;
      let outputTokens = 0;

      // Accumulate tool_use input JSON across deltas
      let currentToolId = '';
      let currentToolName = '';
      let toolInputJson = '';

      for await (const event of stream as any) {
        if (event.type === 'message_start') {
          inputTokens = event.message?.usage?.input_tokens || 0;
        } else if (event.type === 'content_block_start') {
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
          outputTokens = event.usage?.output_tokens || outputTokens;
          yield {
            type: 'stop',
            stopReason: event.delta?.stop_reason || 'end_turn',
          } as StopEvent;
        }
      }

      options.onUsage?.({
        tokensIn: inputTokens,
        tokensOut: outputTokens,
        model,
        keyId: key.id,
      });

      release(true);
    } catch (err) {
      logger.error({ err, keyId: key.id, model }, 'Anthropic API error');
      release(false);
      throw err;
    }
  }

  // --- Claude Code (CLI subprocess) ---

  /** Map of session thread IDs to Claude Code session IDs for conversation continuity. */
  private claudeCodeSessions = new Map<string, string>();

  private async *streamClaudeCode(
    messages: ConversationMessage[],
    _model: string,
    options: StreamOptions,
  ): AsyncGenerator<AIStreamEvent> {
    // Extract the last user message as the prompt
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) {
      yield { type: 'text', text: 'No user message found.' } as TextChunkEvent;
      yield { type: 'stop', stopReason: 'end_turn' } as StopEvent;
      return;
    }

    let prompt: string;
    if (typeof lastUserMsg.content === 'string') {
      prompt = lastUserMsg.content;
    } else {
      prompt = lastUserMsg.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    }

    if (!prompt.trim()) {
      yield { type: 'text', text: 'Empty prompt.' } as TextChunkEvent;
      yield { type: 'stop', stopReason: 'end_turn' } as StopEvent;
      return;
    }

    // Optionally acquire an API key from the pool; if none available,
    // the CLI will use its own login (e.g. Claude Max plan).
    let apiKey: string | undefined;
    let releaseKey: ((success: boolean) => void) | undefined;

    if (this.keyPool.hasKeysForProvider('anthropic')) {
      const acquired = await this.keyPool.acquire('anthropic', options.onQueuePosition);
      apiKey = acquired.key.apiKey;
      releaseKey = acquired.release;
    }

    try {
      // Build CLI args
      const cliArgs = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ];

      // Resume previous Claude Code session if available (for conversation continuity)
      const sessionKey = options.repoContext?.repoUrl || 'default';
      const existingSessionId = this.claudeCodeSessions.get(sessionKey);
      if (existingSessionId) {
        cliArgs.push('--resume', existingSessionId);
      }

      cliArgs.push(prompt);

      // Build env: use pool API key if available, otherwise inherit the
      // host's Claude Code login (Max plan / OAuth) from the environment.
      const env = { ...process.env };
      if (apiKey) {
        env.ANTHROPIC_API_KEY = apiKey;
      }
      // Allow overriding HOME so the CLI finds the correct ~/.claude/ login
      if (config.CLAUDE_CODE_HOME) {
        env.HOME = config.CLAUDE_CODE_HOME;
      }

      logger.debug({ provider: 'claude-code', sessionKey, resume: !!existingSessionId, hasApiKey: !!apiKey, home: env.HOME }, 'Starting Claude Code stream');

      yield* this.spawnClaudeCodeProcess(cliArgs, sessionKey, env, options.onUsage);
      releaseKey?.(true);
    } catch (err) {
      releaseKey?.(false);
      throw err;
    }
  }

  private async *spawnClaudeCodeProcess(
    cliArgs: string[],
    sessionKey: string,
    env: Record<string, string | undefined>,
    onUsage?: StreamOptions['onUsage'],
  ): AsyncGenerator<AIStreamEvent> {
    const proc: ChildProcess = spawn('claude', cliArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let hasYieldedText = false;

    // Create async iterable from stdout
    const events = this.parseClaudeCodeStream(proc, sessionKey, onUsage);

    for await (const event of events) {
      if (event.type === 'text') hasYieldedText = true;
      yield event;
    }

    if (!hasYieldedText) {
      yield { type: 'text', text: '(No response from Claude Code)' } as TextChunkEvent;
    }
    yield { type: 'stop', stopReason: 'end_turn' } as StopEvent;
  }

  private async *parseClaudeCodeStream(
    proc: ChildProcess,
    sessionKey: string,
    onUsage?: StreamOptions['onUsage'],
  ): AsyncGenerator<AIStreamEvent> {
    let buffer = '';

    // Collect all data into a promise-based async iteration
    const lines: string[] = [];
    let resolveNext: ((done: boolean) => void) | null = null;

    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        if (line.trim()) lines.push(line.trim());
      }
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(false);
      }
    });

    let exited = false;
    proc.on('close', () => {
      exited = true;
      // Process remaining buffer
      if (buffer.trim()) {
        lines.push(buffer.trim());
        buffer = '';
      }
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(true);
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      logger.debug({ stderr: chunk.toString() }, 'Claude Code stderr');
    });

    while (true) {
      while (lines.length > 0) {
        const line = lines.shift()!;
        try {
          const msg = JSON.parse(line);
          // Capture usage from result event
          if (msg.type === 'result' && onUsage) {
            onUsage({
              tokensIn: msg.total_input_tokens || msg.input_tokens || 0,
              tokensOut: msg.total_output_tokens || msg.output_tokens || 0,
              costUsd: msg.total_cost_usd || msg.cost_usd || undefined,
              model: msg.model || 'claude-code',
              keyId: 'claude-code',
            });
          }
          const event = this.handleClaudeCodeMessage(msg, sessionKey);
          if (event) yield event;
        } catch {
          // Not valid JSON, skip
        }
      }

      if (exited) break;

      // Wait for more data
      await new Promise<boolean>((resolve) => {
        resolveNext = resolve;
      });
    }
  }

  private handleClaudeCodeMessage(
    msg: any,
    sessionKey: string,
  ): AIStreamEvent | null {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) {
          this.claudeCodeSessions.set(sessionKey, msg.session_id);
          logger.debug({ sessionId: msg.session_id }, 'Claude Code session initialized');
        }
        return null;

      case 'assistant': {
        // Detect auth errors from Claude Code
        if (msg.error === 'authentication_failed') {
          logger.error('Claude Code authentication failed — API key may be invalid');
          return { type: 'text', text: 'Claude Code authentication failed. The API key may be invalid — try `/admin removekey` and `/admin addkey` with a fresh key.' } as TextChunkEvent;
        }

        // Extract text from content blocks
        const content = msg.message?.content;
        if (!Array.isArray(content)) return null;

        const textParts = content
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text);

        if (textParts.length > 0) {
          return { type: 'text', text: textParts.join('') } as TextChunkEvent;
        }
        return null;
      }

      case 'result':
        // The result event contains the final combined text, but we already
        // streamed it via assistant messages, so skip to avoid duplication.
        return null;

      default:
        return null;
    }
  }

  // --- Google (Gemini) ---

  private async *streamGemini(
    messages: ConversationMessage[],
    model: string,
    options: StreamOptions,
  ): AsyncGenerator<AIStreamEvent> {
    const systemPrompt = buildSystemPrompt(options.repoContext, options.enableRepoTools, config.ENABLE_SCRIPT_EXECUTION, config.ENABLE_DEV_TOOLS);
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

      options.onUsage?.({
        tokensIn: 0,
        tokensOut: 0,
        model,
        keyId: key.id,
      });

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
