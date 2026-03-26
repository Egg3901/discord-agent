export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class KeyExhaustedError extends AppError {
  constructor() {
    super('All API keys are exhausted or rate-limited', 'KEY_EXHAUSTED', 429);
  }
}

export class SessionLimitError extends AppError {
  constructor(max: number) {
    super(`Maximum sessions (${max}) reached`, 'SESSION_LIMIT', 429);
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super('Rate limit exceeded, please slow down', 'RATE_LIMITED', 429);
  }
}

export class QueueTimeoutError extends AppError {
  constructor() {
    super('Request timed out waiting in queue', 'QUEUE_TIMEOUT', 408);
  }
}
