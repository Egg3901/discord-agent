export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly userMessage?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class KeyExhaustedError extends AppError {
  constructor() {
    super(
      'All API keys are exhausted or rate-limited',
      'KEY_EXHAUSTED',
      429,
      'All API keys are currently busy or rate-limited. Please try again in a moment.',
    );
  }
}

export class NoKeysConfiguredError extends AppError {
  constructor() {
    super(
      'No API keys configured',
      'NO_KEYS',
      503,
      'No API keys are configured. An admin needs to add one with `/admin addkey`.',
    );
  }
}

export class SessionLimitError extends AppError {
  constructor(max: number) {
    super(
      `Maximum sessions (${max}) reached`,
      'SESSION_LIMIT',
      429,
      `You've reached the maximum of ${max} active sessions. End one with \`/session end\` to start a new one.`,
    );
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(
      'Rate limit exceeded, please slow down',
      'RATE_LIMITED',
      429,
      'You\'re sending messages too fast. Please wait a moment.',
    );
  }
}

export class QueueTimeoutError extends AppError {
  constructor() {
    super(
      'Request timed out waiting in queue',
      'QUEUE_TIMEOUT',
      408,
      'Your request timed out waiting for an available API key. Please try again.',
    );
  }
}

/**
 * Extract a user-friendly error message from an API error (Anthropic or Google).
 */
export function formatApiError(err: unknown): string {
  if (err instanceof AppError && err.userMessage) {
    return err.userMessage;
  }

  if (err && typeof err === 'object') {
    const e = err as any;
    const message = (e.message || '').toLowerCase();

    // Anthropic SDK errors have status + message
    if (e.status === 401 || message.includes('api key not valid')) {
      return 'API key authentication failed. An admin should check the configured keys with `/admin keys`.';
    }
    if (e.status === 403 || message.includes('permission denied')) {
      return 'API key does not have access to this model. Try switching models with `/model`.';
    }
    if (e.status === 404 || message.includes('not found')) {
      return 'Model not found. Try switching to a different model with `/model`.';
    }
    if (e.status === 429 || message.includes('resource exhausted') || message.includes('rate limit')) {
      return 'API rate limit hit. Your request has been queued — please wait.';
    }
    if (e.status === 529 || e.status === 503 || message.includes('overloaded')) {
      return 'API is temporarily overloaded. Please try again in a few seconds.';
    }
    if (e.status >= 500) {
      return 'API server error. Please try again.';
    }

    if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
      return 'Cannot reach the API. Check the server\'s network connection.';
    }

    // Google SDK specific errors
    if (message.includes('api_key_invalid') || message.includes('invalid api key')) {
      return 'Google API key is invalid. An admin should check the configured keys with `/admin keys`.';
    }
    if (message.includes('quota')) {
      return 'Google API quota exceeded. Please try again later or switch models with `/model`.';
    }
  }

  return 'Something went wrong generating a response. Please try again.';
}
