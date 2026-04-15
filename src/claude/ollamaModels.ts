/**
 * Ollama model management: list available models, pull on demand, check status.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Build auth headers for Ollama requests.
 * Cloud-hosted endpoints require a Bearer token; local servers need none.
 */
function ollamaHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.OLLAMA_API_KEY) {
    headers['Authorization'] = `Bearer ${config.OLLAMA_API_KEY}`;
  }
  return headers;
}

/**
 * Returns true when the configured Ollama URL points to a remote (cloud) host.
 * Remote endpoints have models pre-loaded — auto-pull is not applicable.
 */
export function isRemoteOllama(): boolean {
  const url = config.OLLAMA_BASE_URL;
  return !url.includes('localhost') && !url.includes('127.0.0.1') && !url.includes('::1');
}

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
      headers: ollamaHeaders(),
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
      headers: ollamaHeaders(),
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
    headers: ollamaHeaders(),
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

// --- Live library listing (from ollama.com/search) -------------------------
//
// Ollama has no official JSON search API (ollama/ollama#3922, #7751, #8554,
// #9142), so to surface "current" models in /model autocomplete without
// hardcoding, we scrape ollama.com/search. The markup is subject to change;
// everything below is defensive with caching + graceful fallback so a markup
// change can never break the bot — it just means /model falls back to the
// live /api/tags list plus a small curated static list.

export interface LibraryModel {
  /** Slug used when pulling (e.g. "qwen2.5-coder", "library/llama3"). */
  name: string;
  /** Optional short description from the listing card. */
  description?: string;
  /** Parameter-size labels shown on the card (e.g. ["7b", "32b"]). */
  sizes: string[];
  /** Pull count as rendered on the card (e.g. "6.3M"), if parsable. */
  pulls?: string;
}

const LIBRARY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const LIBRARY_FETCH_TIMEOUT_MS = 5_000;
const LIBRARY_PAGES = 3; // top ~75 results
let libraryCache: LibraryModel[] | null = null;
let libraryCacheExpiry = 0;
let inFlightLibraryFetch: Promise<LibraryModel[]> | null = null;

/**
 * Fetch the most popular models from ollama.com/search.
 *
 * Cached for LIBRARY_CACHE_TTL_MS. Concurrent calls share the same in-flight
 * promise so we never fetch twice in parallel. Returns the previous cached
 * value (or an empty array) if the network call fails.
 */
export async function listOllamaLibrary(): Promise<LibraryModel[]> {
  const now = Date.now();
  if (libraryCache && now < libraryCacheExpiry) return libraryCache;
  if (inFlightLibraryFetch) return inFlightLibraryFetch;

  inFlightLibraryFetch = (async () => {
    try {
      const pages = await Promise.all(
        Array.from({ length: LIBRARY_PAGES }, (_, i) => fetchLibraryPage(i + 1)),
      );
      const seen = new Set<string>();
      const merged: LibraryModel[] = [];
      for (const page of pages) {
        for (const m of page) {
          if (seen.has(m.name)) continue;
          seen.add(m.name);
          merged.push(m);
        }
      }
      if (merged.length > 0) {
        libraryCache = merged;
        libraryCacheExpiry = now + LIBRARY_CACHE_TTL_MS;
      }
      return libraryCache || [];
    } catch (err) {
      logger.debug({ err }, 'Failed to fetch Ollama library listing');
      return libraryCache || [];
    } finally {
      inFlightLibraryFetch = null;
    }
  })();

  return inFlightLibraryFetch;
}

async function fetchLibraryPage(page: number): Promise<LibraryModel[]> {
  const resp = await fetch(`https://ollama.com/search?page=${page}`, {
    headers: {
      // ollama.com rejects fetches without a realistic UA.
      'User-Agent': 'Mozilla/5.0 (discord-agent; +https://github.com/Egg3901/discord-agent)',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(LIBRARY_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`ollama.com/search page ${page} returned ${resp.status}`);
  }
  return parseLibraryHtml(await resp.text());
}

/**
 * Parse the /search HTML into LibraryModel entries.
 *
 * The markup has one anchor per card pointing at `/library/<slug>`. Inside the
 * card are size-label chips (e.g. "7b", "70b", "8x22b"), an optional
 * description, and a pulls counter. We split on those anchors and extract each
 * field with narrow regexes — any field we can't match is simply omitted, so
 * markup tweaks degrade gracefully instead of throwing.
 */
export function parseLibraryHtml(html: string): LibraryModel[] {
  const results: LibraryModel[] = [];
  const seen = new Set<string>();

  // Split the document on card anchors. The first chunk is pre-card chrome.
  const cardRegex = /<a\b[^>]*href="\/library\/([a-z0-9][a-z0-9._\-\/]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = cardRegex.exec(html)) !== null) {
    const slug = match[1];
    const body = match[2];
    // Skip obvious non-model links (tags, pagination, etc.).
    if (slug.includes('/tags') || slug.includes('/blobs')) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);

    // Parameter-size chips use a lowercase suffix (`7b`, `8x22b`, `1.5b`).
    // Pull counters use uppercase K/M/B (`6.3M`, `480K`, `2.1B`). The
    // capitalization is what distinguishes the two in the markup.
    const sizes = Array.from(
      body.matchAll(/>\s*(\d+(?:\.\d+)?(?:x\d+)?b)\s*</g),
      (m) => m[1],
    );
    const descMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const description = descMatch
      ? stripTags(descMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 140)
      : undefined;
    const pullsMatch = body.match(/>\s*(\d+(?:\.\d+)?[KMB])\s*</);
    const pulls = pullsMatch ? pullsMatch[1] : undefined;

    results.push({ name: slug, description, sizes, pulls });
  }
  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
