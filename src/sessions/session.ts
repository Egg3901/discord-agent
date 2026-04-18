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

  // Secondary repo (for /synthesize dual-repo sessions)
  secondaryRepoOwner?: string;
  secondaryRepoName?: string;
  secondaryRepoContext?: RepoContext;
  secondaryDefaultBranch?: string;

  // Abort controller for cancelling in-flight requests
  activeController?: AbortController;

  // True while a response is being generated — prevents concurrent message handling
  busy?: boolean;

  // Follow-up prompts queued while the session was busy. Drained after the
  // current agent run completes.
  pendingPrompts?: PendingPrompt[];

  // Timestamp when the user was warned about impending session expiry
  warnedAt?: number;
}

export interface PendingPrompt {
  userId: string;
  content: string;
  imageAttachments?: { mediaType: string; base64Data: string }[];
  /** Shown to the user when the queued item starts processing. */
  label?: string;
}
