import { getDatabase } from '../storage/database.js';
import { logger } from '../utils/logger.js';

/**
 * Classifies a tool result string into ok / empty / error.
 * "empty" covers the "no results" / "no matches" case — useful for spotting
 * tools that technically succeed but produce no useful output.
 */
export type ToolResultClass = 'ok' | 'empty' | 'error';

export function classifyToolResult(result: string): ToolResultClass {
  if (!result) return 'empty';
  const lower = result.toLowerCase();
  if (
    lower.startsWith('error:') ||
    lower.startsWith('error creating') ||
    lower.includes('error: ') && lower.indexOf('error: ') < 20
  ) {
    return 'error';
  }
  if (
    lower.includes('no results found') ||
    lower.includes('no matches for') ||
    lower.includes('no files matched') ||
    lower.includes('file not found') ||
    lower.startsWith('directory is empty or not found') ||
    lower.startsWith('[binary file')
  ) {
    return 'empty';
  }
  return 'ok';
}

export interface ToolMetricRow {
  tool_name: string;
  total_count: number;
  error_count: number;
  empty_count: number;
  total_duration_ms: number;
  last_error: string | null;
  last_error_at: number | null;
  last_called_at: number | null;
}

/**
 * Record a tool invocation. Failures here must never interrupt tool execution,
 * so any DB error is logged and swallowed.
 */
export function recordToolInvocation(
  toolName: string,
  durationMs: number,
  resultClass: ToolResultClass,
  firstErrorLine: string | null,
): void {
  try {
    const db = getDatabase();
    const now = Date.now();
    const errorInc = resultClass === 'error' ? 1 : 0;
    const emptyInc = resultClass === 'empty' ? 1 : 0;

    db.prepare(`
      INSERT INTO tool_metrics (tool_name, total_count, error_count, empty_count, total_duration_ms, last_error, last_error_at, last_called_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tool_name) DO UPDATE SET
        total_count = total_count + 1,
        error_count = error_count + excluded.error_count,
        empty_count = empty_count + excluded.empty_count,
        total_duration_ms = total_duration_ms + excluded.total_duration_ms,
        last_error = CASE WHEN excluded.error_count > 0 THEN excluded.last_error ELSE last_error END,
        last_error_at = CASE WHEN excluded.error_count > 0 THEN excluded.last_error_at ELSE last_error_at END,
        last_called_at = excluded.last_called_at
    `).run(
      toolName,
      errorInc,
      emptyInc,
      durationMs,
      errorInc > 0 ? firstErrorLine : null,
      errorInc > 0 ? now : null,
      now,
    );
  } catch (err) {
    logger.warn({ err, toolName }, 'Failed to record tool metric (non-fatal)');
  }
}

/**
 * Return per-tool stats ordered by total_count desc.
 * Optionally filter by minimum call count.
 */
export function listToolMetrics(opts: { minCalls?: number } = {}): ToolMetricRow[] {
  try {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT tool_name, total_count, error_count, empty_count, total_duration_ms,
             last_error, last_error_at, last_called_at
      FROM tool_metrics
      WHERE total_count >= ?
      ORDER BY total_count DESC
    `).all(opts.minCalls ?? 0) as ToolMetricRow[];
    return rows;
  } catch (err) {
    logger.warn({ err }, 'Failed to list tool metrics');
    return [];
  }
}

/**
 * Reset all tool metrics (admin action).
 */
export function resetToolMetrics(): number {
  try {
    const db = getDatabase();
    const res = db.prepare('DELETE FROM tool_metrics').run();
    return res.changes;
  } catch (err) {
    logger.warn({ err }, 'Failed to reset tool metrics');
    return 0;
  }
}
