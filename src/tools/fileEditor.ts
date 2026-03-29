/**
 * File editor with SEARCH/REPLACE style operations and diff preview.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, normalize, resolve, relative, isAbsolute, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

const MAX_FILE_SIZE = 100_000; // 100KB

/**
 * Validate that a path stays within the sandbox.
 */
async function safePath(sandboxDir: string, userPath: string): Promise<string | null> {
  const resolved = resolve(sandboxDir, normalize(userPath));
  const rel = relative(sandboxDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  // If the target already exists, resolve symlinks and re-check containment.
  try {
    const real = await realpath(resolved);
    const realSandbox = await realpath(sandboxDir);
    if (!real.startsWith(realSandbox + sep) && real !== realSandbox) {
      return null;
    }
  } catch {
    // File doesn't exist yet — logical check above is sufficient
  }
  return resolved;
}

interface EditOperation {
  oldText: string;
  newText: string;
}

/**
 * Apply edits to a file in the sandbox.
 * Returns a diff preview and the modified content on success.
 */
export async function editFile(
  path: string,
  editsJson: string,
  sandboxDir: string,
): Promise<{ success: boolean; diff: string; message: string }> {
  // Parse edits
  let edits: EditOperation[];
  try {
    const parsed = JSON.parse(editsJson);
    if (!Array.isArray(parsed)) {
      return { success: false, diff: '', message: 'Error: edits must be a JSON array' };
    }
    edits = parsed.map(e => ({
      oldText: String(e.oldText ?? e.search ?? ''),
      newText: String(e.newText ?? e.replace ?? ''),
    }));
  } catch (err) {
    return { success: false, diff: '', message: `Error: Invalid JSON for edits parameter. Use: [{"oldText": "...", "newText": "..."}]` };
  }
  
  if (edits.length === 0) {
    return { success: false, diff: '', message: 'Error: No edits provided' };
  }
  
  // Validate path
  const resolved = await safePath(sandboxDir, path);
  if (!resolved) {
    return { success: false, diff: '', message: 'Error: Path escapes the sandbox directory' };
  }
  
  // Read existing file
  let oldContent: string;
  try {
    oldContent = await readFile(resolved, 'utf-8');
    if (oldContent.length > MAX_FILE_SIZE) {
      return { success: false, diff: '', message: `Error: File too large (${Math.round(oldContent.length / 1000)}KB). Use write_file for large files.` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      return { success: false, diff: '', message: `Error: File does not exist: ${path}. Use write_file to create new files.` };
    }
    return { success: false, diff: '', message: `Error reading file: ${msg}` };
  }
  
  // Apply edits
  let newContent = oldContent;
  const diffParts: string[] = [];
  let totalLinesChanged = 0;
  
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    
    if (!edit.oldText) {
      return { success: false, diff: '', message: `Error: Edit ${i + 1} has empty oldText. Use non-empty text to find.` };
    }
    
    const idx = newContent.indexOf(edit.oldText);
    if (idx === -1) {
      // Provide helpful error with context
      const lines = edit.oldText.split('\n');
      if (lines.length === 1) {
        // Single line - find similar lines
        const similar = findSimilarLines(oldContent, edit.oldText);
        if (similar) {
          return {
            success: false,
            diff: '',
            message: `Error: Edit ${i + 1} - Not found. Similar line found:\n  ${similar}`,
          };
        }
      }
      return {
        success: false,
        diff: '',
        message: `Error: Edit ${i + 1} - Could not find text:\n  "${edit.oldText.slice(0, 100)}${edit.oldText.length > 100 ? '...' : ''}"`,
      };
    }
    
    // Calculate line numbers for diff
    const beforeLines = newContent.slice(0, idx).split('\n');
    const startLine = beforeLines.length;
    const oldLines = edit.oldText.split('\n');
    const newLines = edit.newText.split('\n');
    
    // Apply the edit
    newContent = newContent.slice(0, idx) + edit.newText + newContent.slice(idx + edit.oldText.length);
    
    // Generate diff chunk
    diffParts.push(`@@ ${path}:${startLine} @@`);
    for (const line of oldLines) {
      diffParts.push(`-${line}`);
    }
    for (const line of newLines) {
      diffParts.push(`+${line}`);
    }
    
    totalLinesChanged += oldLines.length;
  }
  
  // Write the modified file
  try {
    await writeFile(resolved, newContent, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, diff: '', message: `Error writing file: ${msg}` };
  }
  
  // Generate summary
  const summary = edits.length === 1
    ? `Edited ${path} (1 edit, ${totalLinesChanged} line${totalLinesChanged !== 1 ? 's' : ''} changed)`
    : `Edited ${path} (${edits.length} edits, ${totalLinesChanged} lines changed)`;
  
  // Truncate diff if too long
  const diff = diffParts.join('\n');
  const truncatedDiff = diff.length > 2000 ? diff.slice(0, 2000) + '\n... (diff truncated)' : diff;
  
  return {
    success: true,
    diff: truncatedDiff,
    message: `${summary}\n\`\`\`diff\n${truncatedDiff}\n\`\`\``,
  };
}

/**
 * Find lines similar to the target for helpful error messages.
 */
function findSimilarLines(content: string, target: string): string | null {
  const targetWords = target.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (targetWords.length === 0) return null;
  
  const lines = content.split('\n');
  let bestMatch: { line: string; score: number } | null = null;
  
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    const score = targetWords.filter(w => lowerLine.includes(w)).length;
    
    if (score > (bestMatch?.score ?? 0) && score >= Math.ceil(targetWords.length / 2)) {
      bestMatch = { line: line.trim(), score };
    }
  }
  
  return bestMatch?.line ?? null;
}