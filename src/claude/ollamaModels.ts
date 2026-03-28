/**
 * Ollama model management: list available models, pull on demand, check status.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface OllamaModel {
  name: string;
  size: number;
  modifiedAt: string;
}

/** Cache of available models with short TTL */
let modelCache: OllamaModel[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30_000;

/**
 * List models currently available (downloaded) on the Ollama server.
 */
export async function listOllamaModels(): Promise<OllamaModel[]> {
  const now = Date.now();
  if (modelCache && now < cacheExpiry) return modelCache;

  const baseUrl = config.OLLAMA_BASE_URL;
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return modelCache || [];
    const data = await resp.json() as any;
    const models: OllamaModel[] = (data.models || []).map((m: any) => ({
      name: m.name as string,
      size: m.size as number,
      modifiedAt: m.modified_at as string,
    }));
    modelCache = models;
    cacheExpiry = now + CACHE_TTL_MS;
    return models;
  } catch {
    return modelCache || [];
  }
}

/**
 * Check if a specific model is available locally.
 */
export async function isModelAvailable(modelName: string): Promise<boolean> {
  const models = await listOllamaModels();
  // Ollama names can be "qwen2.5-coder:32b" or "qwen2.5-coder:32b" with tag
  // Match both exact and without ":latest" tag
  return models.some((m) =>
    m.name === modelName ||
    m.name === `${modelName}:latest` ||
    m.name.replace(':latest', '') === modelName,
  );
}

/**
 * Check if the Ollama server is reachable.
 */
export async function isOllamaReachable(): Promise<boolean> {
  try {
    const resp = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Track in-flight pulls to deduplicate concurrent requests for the same model. */
const activePulls = new Map<string, Promise<void>>();

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  /** 0-100 percentage, or null if indeterminate */
  percent: number | null;
}

/**
 * Ensure a model is pulled, deduplicating concurrent requests.
 * Calls onProgress with status updates suitable for Discord messages.
 */
export async function ensureModelPulled(
  modelName: string,
  onProgress?: (progress: PullProgress) => void,
): Promise<void> {
  const existing = activePulls.get(modelName);
  if (existing) {
    // Another request is already pulling this model — wait for it
    return existing;
  }

  const pullPromise = (async () => {
    for await (const progress of pullOllamaModel(modelName)) {
      onProgress?.(progress);
    }
  })();

  activePulls.set(modelName, pullPromise);
  try {
    await pullPromise;
  } finally {
    activePulls.delete(modelName);
  }
}

/**
 * Pull (download) an Ollama model, yielding progress events.
 * This streams the pull and yields progress updates suitable for Discord status messages.
 */
async function* pullOllamaModel(modelName: string): AsyncGenerator<PullProgress> {
  const baseUrl = config.OLLAMA_BASE_URL;
  logger.info({ model: modelName }, 'Pulling Ollama model');

  const resp = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, stream: true }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Ollama pull failed (${resp.status}): ${errText}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body from Ollama pull');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const percent = msg.total && msg.completed
            ? Math.round((msg.completed / msg.total) * 100)
            : null;
          yield {
            status: msg.status || 'downloading',
            completed: msg.completed,
            total: msg.total,
            percent,
          };
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  // Invalidate cache so the new model appears
  modelCache = null;
  cacheExpiry = 0;

  logger.info({ model: modelName }, 'Ollama model pull complete');
}

/**
 * Format a model size in bytes to a human-readable string.
 */
export function formatModelSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)}GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)}MB`;
  return `${bytes}B`;
}
