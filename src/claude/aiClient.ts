import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { spawn, type ChildProcess } from 'node:child_process';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { KeyPool } from '../keys/keyPool.js';
import { buildSystemPrompt, trimConversation, type RepoContext } from './contextBuilder.js';
import { AGENT_TOOLS, SANDBOX_TOOLS, DEV_TOOLS, WEB_TOOLS, toGeminiFunctionDeclarations } from '../tools/toolDefinitions.js';
import { getSandboxDir } from '../tools/scriptExecutor.js';
import { saveClaudeCodeSession, loadClaudeCodeSessionMap } from '../storage/database.js';
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
  /** Per-session thinking override (null/undefined = use global config) */
  thinkingEnabled?: boolean | null;
  thinkingBudget?: number | null;
  /** Abort signal to cancel the in-flight request */
  signal?: AbortSignal;
  /** Whether web search tools are available */
  enableWebSearch?: boolean;
  /** Image attachments to include with the next user message */
  imageAttachments?: { mediaType: string; base64Data: string }[];
  /** Session ID — used to isolate the Claude Code subprocess workspace and session continuity */
  sessionId?: string;
  /** Custom system prompt to prepend (persona) */
  customSystemPrompt?: string;
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
  if (options.enableWebSearch) {
    tools.push(...WEB_TOOLS);
  }
  return tools;
}

export class AIClient {
  constructor(private keyPool: KeyPool) {
    // Restore persisted Claude Code sessions so --resume works across restarts
    try {
      const stored = loadClaudeCodeSessionMap();
      for (const [key, id] of Object.entries(stored)) {
        this.claudeCodeSessions.set(key, id);
      }
    } catch {
      // Non-fatal: start fresh if DB isn't ready yet
    }
  }

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
    const systemPrompt = buildSystemPrompt(options.repoContext, options.enableRepoTools, config.ENABLE_SCRIPT_EXECUTION, config.ENABLE_DEV_TOOLS, options.enableWebSearch, options.customSystemPrompt);
    // Reserve token budget for the system prompt so conversation trimming is accurate
    const systemTokenEstimate = Math.ceil(systemPrompt.length / 4);
    const trimmed = trimConversation(messages, Math.max(config.MAX_CONTEXT_TOKENS - systemTokenEstimate, 4096));

    // Convert messages to Anthropic format
    const anthropicMessages = trimmed.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content as any, // Anthropic SDK accepts string | ContentBlock[]
    }));

    // Add prompt caching to the penultimate user message so all prior context is cached
    if (anthropicMessages.length >= 3) {
      // Find the second-to-last user message
      let count = 0;
      for (let i = anthropicMessages.length - 1; i >= 0; i--) {
        if (anthropicMessages[i].role === 'user') {
          count++;
          if (count === 2) {
            const content = anthropicMessages[i].content;
            if (typeof content === 'string') {
              anthropicMessages[i].content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] as any;
            } else if (Array.isArray(content) && content.length > 0) {
              const last = content[content.length - 1];
              (last as any).cache_control = { type: 'ephemeral' };
            }
            break;
          }
        }
      }
    }

    // Inject image attachments into the last user message
    if (options.imageAttachments?.length) {
      const lastUser = [...anthropicMessages].reverse().find((m) => m.role === 'user');
      if (!lastUser) {
        logger.warn('Image attachments provided but no user message found to attach them to');
      } else if (lastUser) {
        const textContent = typeof lastUser.content === 'string' ? lastUser.content : '';
        const blocks: any[] = [];
        for (const img of options.imageAttachments) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.base64Data },
          });
        }
        blocks.push({ type: 'text', text: textContent || '(see attached image)' });
        lastUser.content = blocks;
      }
    }

    const { key, release } = await this.keyPool.acquire('anthropic', options.onQueuePosition);

    try {
      const client = new Anthropic({ apiKey: key.apiKey });
      logger.debug({ model, keyId: key.id, provider: 'anthropic' }, 'Starting stream');

      // Resolve thinking: per-session override > global config
      const useThinking = options.thinkingEnabled != null
        ? options.thinkingEnabled
        : config.ENABLE_EXTENDED_THINKING;
      const thinkingBudget = options.thinkingBudget || config.THINKING_BUDGET_TOKENS;

      const params: Record<string, any> = {
        model,
        max_tokens: useThinking ? thinkingBudget + 16384 : 16384,
        system: applyPromptCaching(systemPrompt),
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
          budget_tokens: thinkingBudget,
        };
      }

      // Retry on transient 529/503 (overloaded) errors with exponential backoff
      let stream: any;
      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          // Check abort signal before each attempt
          if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          stream = await client.messages.create(params as any);
          break;
        } catch (retryErr: any) {
          if (retryErr?.name === 'AbortError') throw retryErr;
          const status = retryErr?.status;
          if ((status === 529 || status === 503) && attempt < MAX_RETRIES) {
            const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
            logger.warn({ attempt: attempt + 1, delay, status }, 'API overloaded, retrying');
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw retryErr;
        }
      }

      // Track usage
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreationTokens = 0;

      // Accumulate tool_use input JSON across deltas
      let currentToolId = '';
      let currentToolName = '';
      let toolInputJson = '';

      for await (const event of stream as any) {
        // Check abort signal during streaming
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        if (event.type === 'message_start') {
          inputTokens = event.message?.usage?.input_tokens || 0;
          cacheReadTokens = event.message?.usage?.cache_read_input_tokens || 0;
          cacheCreationTokens = event.message?.usage?.cache_creation_input_tokens || 0;
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

      if (cacheReadTokens || cacheCreationTokens) {
        logger.debug({ cacheReadTokens, cacheCreationTokens }, 'Prompt cache stats');
      }

      options.onUsage?.({
        tokensIn: inputTokens,
        tokensOut: outputTokens,
        model,
        keyId: key.id,
      });

      release(true);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        release(true); // Not a key failure
        return;
      }
      logger.error({ err, keyId: key.id, model }, 'Anthropic API error');
      release(false);
      throw err;
    }
  }

  // --- Claude Code (CLI subprocess) ---

  /** Map of session thread IDs to Claude Code session IDs for conversation continuity. */
  private claudeCodeSessions = new Map<string, string>();

  clearClaudeCodeSession(sessionKey: string): void {
    this.claudeCodeSessions.delete(sessionKey);
  }

  private async *streamClaudeCode(
    messages: ConversationMessage[],
    model: string,
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

    // The CLI will use its own login (e.g. Claude Max plan / OAuth).
    // We do NOT pass a pool API key here — that would override the CLI's
    // own auth and cause "credit balance too low" errors when pool keys
    // have limited credits.

    try {
      // Build CLI args
      const cliArgs = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ];

      // Pass model override to CLI (e.g. "claude-code-sonnet" -> "sonnet")
      const cliModel = model.replace(/^claude-code-?/, '');
      if (cliModel && cliModel !== 'claude-code') {
        cliArgs.push('--model', cliModel);
      }

      // Session key: use sessionId (Discord thread) first so each user session is isolated.
      // Fallback chain: sessionId > repoUrl > 'default'
      const sessionKey = options.sessionId || options.repoContext?.repoUrl || 'default';
      const existingSessionId = this.claudeCodeSessions.get(sessionKey);
      if (existingSessionId) {
        cliArgs.push('--resume', existingSessionId);
      }

      cliArgs.push(prompt);

      // Get or create a per-session sandbox directory so the CC subprocess has an isolated workspace.
      const sandboxDir = await getSandboxDir(options.sessionId);

      // Build env: inherit the host's Claude Code login (Max plan / OAuth).
      const env = { ...process.env };
      // Pass GITHUB_TOKEN so the CLI can authenticate git operations
      if (config.GITHUB_TOKEN) {
        env.GITHUB_TOKEN = config.GITHUB_TOKEN;
      }
      // Allow overriding HOME so the CLI finds the correct ~/.claude/ login
      if (config.CLAUDE_CODE_HOME) {
        env.HOME = config.CLAUDE_CODE_HOME;
      }

      logger.debug({ provider: 'claude-code', sessionKey, resume: !!existingSessionId, sandboxDir, home: env.HOME }, 'Starting Claude Code stream');

      yield* this.spawnClaudeCodeProcess(cliArgs, sessionKey, sandboxDir, env, options.onUsage);
    } catch (err) {
      throw err;
    }
  }

  private async *spawnClaudeCodeProcess(
    cliArgs: string[],
    sessionKey: string,
    sandboxDir: string,
    env: Record<string, string | undefined>,
    onUsage?: StreamOptions['onUsage'],
  ): AsyncGenerator<AIStreamEvent> {
    const proc: ChildProcess = spawn('claude', cliArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: sandboxDir,
    });

    let hasYieldedText = false;
    let timedOut = false;

    const timeoutMs = config.CLAUDE_CODE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      logger.warn({ sessionKey, timeoutMs }, 'Claude Code subprocess timed out');
    }, timeoutMs);

    const events = this.parseClaudeCodeStream(proc, sessionKey, onUsage);

    try {
      for await (const event of events) {
        if (event.type === 'text') hasYieldedText = true;
        yield event;
      }
    } finally {
      clearTimeout(timer);
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners();
      if (proc.exitCode === null) proc.kill('SIGTERM');
      proc.unref();
    }

    if (timedOut) {
      yield { type: 'text', text: `[Claude Code timed out after ${timeoutMs / 1000}s. The task may be too complex — try breaking it into smaller steps.]` } as TextChunkEvent;
    } else if (!hasYieldedText) {
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
      // Backpressure: pause reading if too much buffered
      if (lines.length > 100) {
        proc.stdout!.pause();
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
          for (const event of this.handleClaudeCodeMessage(msg, sessionKey)) {
            yield event;
          }
        } catch {
          // Not valid JSON, skip
        }
      }

      // Resume reading if buffer is drained
      if (lines.length < 50 && proc.stdout && !proc.stdout.destroyed) {
        proc.stdout.resume();
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
  ): AIStreamEvent[] {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) {
          this.claudeCodeSessions.set(sessionKey, msg.session_id);
          saveClaudeCodeSession(sessionKey, msg.session_id);
          logger.debug({ sessionId: msg.session_id }, 'Claude Code session initialized');
        }
        return [];

      case 'assistant': {
        // Detect auth errors from Claude Code
        if (msg.error === 'authentication_failed') {
          logger.error('Claude Code authentication failed — API key may be invalid');
          return [{ type: 'text', text: 'Claude Code authentication failed. The API key may be invalid — try `/admin removekey` and `/admin addkey` with a fresh key.' } as TextChunkEvent];
        }

        const content = msg.message?.content;
        if (!Array.isArray(content)) return [];

        const events: AIStreamEvent[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            events.push({ type: 'text', text: block.text } as TextChunkEvent);
          } else if (block.type === 'tool_use' && block.name) {
            // Emit tool_use events so callers can display notifications.
            // CC handles execution internally — callers must NOT re-execute these.
            events.push({
              type: 'tool_use',
              id: block.id || '',
              name: block.name,
              input: block.input || {},
            } as ToolUseEvent);
          }
        }
        return events;
      }

      case 'result':
        // The result event contains the final combined text, but we already
        // streamed it via assistant messages, so skip to avoid duplication.
        return [];

      default:
        return [];
    }
  }

  // --- Google (Gemini) ---

  private async *streamGemini(
    messages: ConversationMessage[],
    model: string,
    options: StreamOptions,
  ): AsyncGenerator<AIStreamEvent> {
    // Check abort signal before starting
    if (options.signal?.aborted) return;

    const systemPrompt = buildSystemPrompt(options.repoContext, options.enableRepoTools, config.ENABLE_SCRIPT_EXECUTION, config.ENABLE_DEV_TOOLS, options.enableWebSearch, options.customSystemPrompt);
    const systemTokenEstimate = Math.ceil(systemPrompt.length / 4);
    const trimmed = trimConversation(messages, Math.max(config.MAX_CONTEXT_TOKENS - systemTokenEstimate, 4096));

    const { key, release } = await this.keyPool.acquire('google', options.onQueuePosition);

    try {
      const genai = new GoogleGenAI({ apiKey: key.apiKey });
      logger.debug({ model, keyId: key.id, provider: 'google' }, 'Starting stream');

      // Convert messages to Gemini format with proper function call/result parts
      const geminiContents = toGeminiContents(trimmed);

      // Inject image attachments into the last user message
      if (options.imageAttachments?.length) {
        for (let i = geminiContents.length - 1; i >= 0; i--) {
          if (geminiContents[i].role === 'user') {
            for (const img of options.imageAttachments) {
              geminiContents[i].parts.unshift({
                inlineData: { mimeType: img.mediaType, data: img.base64Data },
              });
            }
            break;
          }
        }
      }

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

      // Resolve thinking: per-session override > global config
      const useThinking = options.thinkingEnabled != null
        ? options.thinkingEnabled
        : config.ENABLE_EXTENDED_THINKING;
      const thinkingBudget = options.thinkingBudget || config.THINKING_BUDGET_TOKENS;

      if (useThinking) {
        geminiConfig.thinkingConfig = {
          thinkingBudget,
        };
      }

      const response = await genai.models.generateContentStream({
        model,
        contents: geminiContents,
        config: geminiConfig,
      });

      let hasToolCalls = false;
      for await (const chunk of response) {
        // Check abort signal during streaming
        if (options.signal?.aborted) {
          release(true);
          return;
        }
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

      // Extract usage from the last chunk's metadata
      const usageMeta = (response as any).usageMetadata;
      options.onUsage?.({
        tokensIn: usageMeta?.promptTokenCount || 0,
        tokensOut: usageMeta?.candidatesTokenCount || 0,
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
 * Wrap a system prompt string into Anthropic's cached system block format.
 * Marks the system prompt as ephemeral so Anthropic caches it across turns.
 */
function applyPromptCaching(systemPrompt: string): any[] {
  return [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ];
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
