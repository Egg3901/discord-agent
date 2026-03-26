import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { KeyPool } from '../keys/keyPool.js';
import { buildSystemPrompt, trimConversation, type RepoContext } from './contextBuilder.js';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamOptions {
  repoContext?: RepoContext;
  modelOverride?: string;
}

export class AnthropicClient {
  constructor(private keyPool: KeyPool) {}

  /**
   * Stream a response from Claude, yielding text chunks as they arrive.
   */
  async *streamResponse(
    messages: ConversationMessage[],
    options: StreamOptions = {},
  ): AsyncGenerator<string> {
    const systemPrompt = buildSystemPrompt(options.repoContext);
    const trimmed = trimConversation(messages, config.MAX_CONTEXT_TOKENS);
    const model = options.modelOverride || config.ANTHROPIC_MODEL;

    const { key, release } = await this.keyPool.acquire();

    try {
      const client = new Anthropic({ apiKey: key.apiKey });

      logger.debug({ model, keyId: key.id }, 'Starting Claude stream');

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

  /**
   * Non-streaming single response (for simpler use cases).
   */
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
}
