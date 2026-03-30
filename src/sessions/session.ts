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
  defaultBranch?: string;
  createdAt: number;
  lastActiveAt: number;

  // Per-session thinking override (null = use global config)
  thinkingEnabled?: boolean | null;
  thinkingBudget?: number | null;

  // Custom system prompt override (persona)
  systemPrompt?: string;

  // Abort controller for cancelling in-flight requests
  activeController?: AbortController;

  // True while a response is being generated — prevents concurrent message handling
  busy?: boolean;

  // Timestamp when the user was warned about impending session expiry
  warnedAt?: number;
}
