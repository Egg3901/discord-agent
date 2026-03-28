import type { ConversationMessage } from '../claude/aiClient.js';
import type { RepoContext } from '../claude/contextBuilder.js';

export interface Session {
  id: string;
  userId: string;
  threadId: string;
  channelId: string;
  messages: ConversationMessage[];
  repoContext?: RepoContext;
  modelOverride?: string;
  repoOwner?: string;
  repoName?: string;
  createdAt: number;
  lastActiveAt: number;

  // Per-session thinking override (null = use global config)
  thinkingEnabled?: boolean | null;
  thinkingBudget?: number | null;

  // Custom system prompt override (persona)
  systemPrompt?: string;

  // Abort controller for cancelling in-flight requests
  activeController?: AbortController;

  // Timestamp when the user was warned about impending session expiry
  warnedAt?: number;
}
