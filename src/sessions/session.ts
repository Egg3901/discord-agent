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

  // Abort controller for cancelling in-flight requests
  activeController?: AbortController;
}
