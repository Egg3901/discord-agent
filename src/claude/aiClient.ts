import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { KeyPool } from '../keys/keyPool.js';
import { buildSystemPrompt, trimConversation, type RepoContext } from './contextBuilder.js';
import type { Provider } from '../keys/types.js';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamOptions {
  repoContext?: RepoContext;
  modelOverride?: string;
  onQueuePosition?: (position: number) => void;
}

/**
 * Model-to-provider mapping. Determines which API to call based on model name.
 */
const GOOGLE_MODEL_PREFIXES = ['gemini-'];

export function getProviderForModel(model: string): Provider {
  if (GOOGLE_MODEL_PREFIXES.some((p) => model.startsWith(p))) {
    return 'google';
  }
  return 'anthropic';
}

export class AIClient {
  constructor(private keyPool: KeyPool) {}

  /**
   * Stream a response, routing to the correct provider based on model name.
   */
  async *streamResponse(
    messages: ConversationMessage[],
    options: StreamOptions = {},
  ): AsyncGenerator<string> {
    const model = options.modelOverride || config.ANTHROPIC_MODEL;
    const provider = getProviderForModel(model);

    if (provider === 'google') {
      yield* this.streamGemini(messages, model, options);
    } else {
      yield* this.streamAnthropic(messages, model, options);
    }
  }

  async getResponse(
    messages: ConversationMessage[],
    options: StreamOptions = {},
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of this.streamResponse(messages, options)) {
      chunks.push(chunk);
    }
    return chunks.join('');
  }

  // --- Anthropic (Claude) ---

  private async *streamAnthropic(
    messages: ConversationMessage[],
    model: string,
    options: StreamOptions,
  ): AsyncGenerator<string> {
    const systemPrompt = buildSystemPrompt(options.repoContext);
    const trimmed = trimConversation(messages, config.MAX_CONTEXT_TOKENS);

    const { key, release } = await this.keyPool.acquire('anthropic', options.onQueuePosition);

    try {
      const client = new Anthropic({ apiKey: key.apiKey });
      logger.debug({ model, keyId: key.id, provider: 'anthropic' }, 'Starting stream');

      const stream = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: trimmed,
        stream: true,
      });

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield event.delta.text;
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
  ): AsyncGenerator<string> {
    const systemPrompt = buildSystemPrompt(options.repoContext);
    const trimmed = trimConversation(messages, config.MAX_CONTEXT_TOKENS);

    const { key, release } = await this.keyPool.acquire('google', options.onQueuePosition);

    try {
      const genai = new GoogleGenAI({ apiKey: key.apiKey });
      logger.debug({ model, keyId: key.id, provider: 'google' }, 'Starting stream');

      // Convert messages to Gemini format
      const geminiContents = trimmed.map((m) => ({
        role: m.role === 'assistant' ? 'model' as const : 'user' as const,
        parts: [{ text: m.content }],
      }));

      const response = await genai.models.generateContentStream({
        model,
        contents: geminiContents,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 4096,
        },
      });

      for await (const chunk of response) {
        const text = chunk.text;
        if (text) {
          yield text;
        }
      }

      release(true);
    } catch (err) {
      logger.error({ err, keyId: key.id, model }, 'Gemini API error');
      release(false);
      throw err;
    }
  }
}
