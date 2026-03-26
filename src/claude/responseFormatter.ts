import type { Message, TextChannel, ThreadChannel } from 'discord.js';
import { splitMessage } from '../utils/chunks.js';
import { logger } from '../utils/logger.js';

const STREAM_FLUSH_INTERVAL_MS = 1500;
const DISCORD_RATE_LIMIT_BUFFER_MS = 1200;

/**
 * Streams Claude's response into a Discord thread/channel,
 * handling chunking and Discord rate limits.
 */
export class ResponseStreamer {
  private buffer = '';
  private sentMessages: Message[] = [];
  private currentMessage: Message | null = null;
  private lastEditTime = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private channel: TextChannel | ThreadChannel,
    private initialMessage?: Message,
  ) {
    if (initialMessage) {
      this.currentMessage = initialMessage;
    }
  }

  /**
   * Feed a token/chunk from the stream into the formatter.
   */
  async push(text: string): Promise<void> {
    this.buffer += text;

    // Periodically update the current message with buffered content
    const now = Date.now();
    if (now - this.lastEditTime >= STREAM_FLUSH_INTERVAL_MS) {
      await this.flushBuffer(false);
    }
  }

  /**
   * Called when the stream is complete. Sends any remaining content.
   */
  async finish(): Promise<Message[]> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flushBuffer(true);
    return this.sentMessages;
  }

  /**
   * Send an error message.
   */
  async sendError(error: string): Promise<void> {
    const content = `⚠️ ${error}`;
    if (this.currentMessage && this.sentMessages.length === 0) {
      await this.currentMessage.edit(content);
    } else {
      await this.channel.send(content);
    }
  }

  private async flushBuffer(final: boolean): Promise<void> {
    if (this.buffer.length === 0 && !final) return;

    const content = this.buffer;

    if (content.length <= 1900) {
      // Fits in one message — edit current or send new
      await this.editOrSend(content || '...');
      if (final) {
        this.buffer = '';
      }
    } else {
      // Need to split into chunks
      const chunks = splitMessage(content);
      this.buffer = '';

      for (let i = 0; i < chunks.length; i++) {
        const isFinalChunk = final && i === chunks.length - 1;

        if (i === 0) {
          await this.editOrSend(chunks[i]);
        } else {
          // Send new messages for subsequent chunks
          await this.rateLimitWait();
          const msg = await this.channel.send(chunks[i]);
          this.sentMessages.push(msg);
          this.currentMessage = msg;
        }

        if (!isFinalChunk && !final && i === chunks.length - 1) {
          // Keep the last incomplete chunk in the buffer
          // Actually, since we split the full buffer, all chunks are final
        }
      }
    }

    if (final) {
      this.buffer = '';
    }

    this.lastEditTime = Date.now();
  }

  private async editOrSend(content: string): Promise<void> {
    try {
      if (this.currentMessage && this.sentMessages.length === 0) {
        // Edit the initial "Thinking..." message
        await this.currentMessage.edit(content);
        this.sentMessages.push(this.currentMessage);
      } else if (this.currentMessage && this.sentMessages.length > 0) {
        // Edit the last sent message (streaming update)
        const lastMsg = this.sentMessages[this.sentMessages.length - 1];
        await lastMsg.edit(content);
      } else {
        // No initial message — send a new one
        await this.rateLimitWait();
        const msg = await this.channel.send(content);
        this.sentMessages.push(msg);
        this.currentMessage = msg;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to edit/send Discord message');
    }
  }

  private async rateLimitWait(): Promise<void> {
    const elapsed = Date.now() - this.lastEditTime;
    if (elapsed < DISCORD_RATE_LIMIT_BUFFER_MS) {
      await new Promise((r) => setTimeout(r, DISCORD_RATE_LIMIT_BUFFER_MS - elapsed));
    }
  }
}
