import type { ConversationMessage } from '../claude/anthropicClient.js';
import type { RepoContext } from '../claude/contextBuilder.js';

export interface Session {
  id: string;
  userId: string;
  threadId: string;
  channelId: string;
  messages: ConversationMessage[];
  repoContext?: RepoContext;
  createdAt: number;
  lastActiveAt: number;
}
