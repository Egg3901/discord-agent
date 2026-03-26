import type { Message, TextChannel, ThreadChannel } from 'discord.js';
import { splitMessage } from '../utils/chunks.js';
import { logger } from '../utils/logger.js';

const STREAM_FLUSH_INTERVAL_MS = 1500;
const DISCORD_RATE_LIMIT_BUFFER_MS = 1200;
const TYPING_INTERVAL_MS = 8000;
const PROGRESS_DOTS_INTERVAL_MS = 3000;

/**
 * Streams Claude's response into a Discord thread/channel,
 * handling chunking, Discord rate limits, and live progress updates.
 */
export class ResponseStreamer {
  private buffer = '';
  private sentMessages: Message[] = [];
  private currentMessage: Message | null = null;
  private lastEditTime = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private dotCount = 0;
  private firstTokenReceived = false;
  private startTime = Date.now();

  constructor(
    private channel: TextChannel | ThreadChannel,
    private initialMessage?: Message,
  ) {
    if (initialMessage) {
      this.currentMessage = initialMessage;
    }

    // Keep typing indicator alive while waiting for response
    this.typingTimer = setInterval(() => {
      this.channel.sendTyping().catch(() => {});
    }, TYPING_INTERVAL_MS);

    // Animate the "Thinking..." message while waiting for first token
    this.progressTimer = setInterval(async () => {
      if (!this.firstTokenReceived && this.currentMessage) {
        this.dotCount = (this.dotCount + 1) % 4;
        const dots = '.'.repeat(this.dotCount || 1);
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const status = elapsed > 5
          ? `Thinking${dots} (${elapsed}s)`
          : `Thinking${dots}`;
        try {
          await this.currentMessage.edit(status);
        } catch {
          // Ignore edit failures during animation
        }
      }
    }, PROGRESS_DOTS_INTERVAL_MS);
  }

  /**
   * Feed a token/chunk from the stream into the formatter.
   */
  async push(text: string): Promise<void> {
    if (!this.firstTokenReceived) {
      this.firstTokenReceived = true;
      // Stop the progress animation once we have content
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
    }

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
    this.stopTimers();
    await this.flushBuffer(true);
    return this.sentMessages;
  }

  /**
   * Send an error message.
   */
  async sendError(error: string): Promise<void> {
    this.stopTimers();
    const content = `Something went wrong: ${error}`;
    if (this.currentMessage && this.sentMessages.length === 0) {
      await this.currentMessage.edit(content);
    } else {
      await this.channel.send(content);
    }
  }

  private stopTimers(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
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
        if (i === 0) {
          await this.editOrSend(chunks[i]);
        } else {
          // Send new messages for subsequent chunks
          await this.rateLimitWait();
          const msg = await this.channel.send(chunks[i]);
          this.sentMessages.push(msg);
          this.currentMessage = msg;
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
