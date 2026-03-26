import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { KeyPool } from '../keys/keyPool.js';
import { buildSystemPrompt, trimConversation, type RepoContext } from './contextBuilder.js';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class AnthropicClient {
  constructor(private keyPool: KeyPool) {}

  /**
   * Stream a response from Claude, yielding text chunks as they arrive.
   */
  async *streamResponse(
    messages: ConversationMessage[],
    repoContext?: RepoContext,
  ): AsyncGenerator<string> {
    const systemPrompt = buildSystemPrompt(repoContext);
    const trimmed = trimConversation(messages, config.MAX_CONTEXT_TOKENS);

    const { key, release } = await this.keyPool.acquire();

    try {
      const client = new Anthropic({ apiKey: key.apiKey });

      const stream = await client.messages.create({
        model: config.ANTHROPIC_MODEL,
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
      logger.error({ err, keyId: key.id }, 'Anthropic API error');
      release(false);
      throw err;
    }
  }

  /**
   * Non-streaming single response (for simpler use cases).
   */
  async getResponse(
    messages: ConversationMessage[],
    repoContext?: RepoContext,
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of this.streamResponse(messages, repoContext)) {
      chunks.push(chunk);
    }
    return chunks.join('');
  }
}
