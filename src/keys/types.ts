export type KeyStatus = 'healthy' | 'degraded' | 'dead';

export interface ManagedKey {
  id: string;
  apiKey: string;
  status: KeyStatus;
  requestsThisMinute: number;
  requestsToday: number;
  totalRequests: number;
  lastUsed: number;
  consecutiveFailures: number;
  rateLimitResetAt: number | null;
}

export interface KeyPoolStats {
  total: number;
  healthy: number;
  degraded: number;
  dead: number;
  queueDepth: number;
  requestsThisMinute: number;
}

export interface AcquiredKey {
  key: ManagedKey;
  release: (success: boolean) => void;
}
