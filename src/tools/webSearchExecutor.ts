import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const MAX_RESULTS = 8;
const MAX_FETCH_SIZE = 50_000; // 50KB text content limit
const FETCH_TIMEOUT_MS = 15_000;

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

/**
 * Search the web using Brave Search API.
 */
export async function webSearch(query: string): Promise<string> {
  const apiKey = config.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return 'Error: BRAVE_SEARCH_API_KEY is not configured. An admin can set it with `/config set BRAVE_SEARCH_API_KEY <key>`.';
  }

  if (!query || query.length > 400) {
    return 'Error: query must be 1-400 characters.';
  }

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
    const resp = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      logger.warn({ status: resp.status, text: text.slice(0, 200) }, 'Brave Search API error');
      return `Error: Search API returned ${resp.status}. ${text.slice(0, 100)}`;
    }

    const data = await resp.json() as any;
    const results: BraveSearchResult[] = (data.web?.results || []).slice(0, MAX_RESULTS);

    if (results.length === 0) {
      return `No results found for: ${query}`;
    }

    return results
      .map((r, i) => `[${i + 1}] **${r.title}**\n${r.url}\n${r.description || ''}`)
      .join('\n\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, query }, 'Web search failed');
    return `Error: ${message}`;
  }
}

/**
 * Fetch text content from a URL, stripping HTML tags.
 */
export async function webFetch(url: string): Promise<string> {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return 'Error: URL must start with http:// or https://';
  }

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DiscordAgent/1.0)',
        'Accept': 'text/html,text/plain,application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!resp.ok) {
      return `Error: HTTP ${resp.status} ${resp.statusText}`;
    }

    const contentType = resp.headers.get('content-type') || '';
    const raw = await resp.text();

    let text: string;
    if (contentType.includes('json')) {
      text = raw;
    } else if (contentType.includes('html')) {
      text = stripHtml(raw);
    } else {
      text = raw;
    }

    if (text.length > MAX_FETCH_SIZE) {
      return text.slice(0, MAX_FETCH_SIZE) + `\n\n[Truncated — page is ${Math.round(text.length / 1000)}KB]`;
    }
    return text || '(empty page)';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, url }, 'Web fetch failed');
    return `Error: ${message}`;
  }
}

/**
 * Minimal HTML-to-text conversion: strips tags, scripts, styles, and collapses whitespace.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
