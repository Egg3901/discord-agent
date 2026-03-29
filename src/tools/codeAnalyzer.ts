/**
 * Code structure analysis tools.
 * Lightweight regex-based parsing for understanding code relationships
 * without requiring a full LSP.
 */

import type { RepoFetcher } from '../github/repoFetcher.js';

const MAX_RESULTS = 50;
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.rs',
  '.go',
  '.java', '.kt', '.kts',
  '.rb',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  '.cs',
  '.php',
  '.swift',
  '.scala', '.sc',
  '.lua',
  '.r', '.R',
]);

function isCodeFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.'));
  return CODE_EXTENSIONS.has(ext);
}

interface Edit {
  oldText: string;
  newText: string;
}

/**
 * Apply SEARCH/REPLACE style edits to a file.
 * Returns a unified diff preview and the modified content.
 */
export function applyEdits(content: string, edits: Edit[]): { success: boolean; diff: string; result?: string; errors: string[] } {
  const errors: string[] = [];
  const diffParts: string[] = [];
  let modified = content;
  let linesChanged = 0;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    
    if (!edit.oldText) {
      errors.push(`Edit ${i + 1}: oldText is empty`);
      continue;
    }

    // Try to find the oldText in the current content
    const startIndex = modified.indexOf(edit.oldText);
    
    if (startIndex === -1) {
      // Try to suggest closest match
      const lines = edit.oldText.split('\n');
      if (lines.length === 1) {
        // Single line - try fuzzy match
        const found = findClosestMatch(modified, edit.oldText);
        if (found) {
          errors.push(`Edit ${i + 1}: Not found. Closest match at line ${found.line}: "${found.text.slice(0, 50)}..."`);
        } else {
          errors.push(`Edit ${i + 1}: Could not find "${edit.oldText.slice(0, 50)}..." in file`);
        }
      } else {
        // Multi-line - find first line
        const firstLineIdx = modified.indexOf(lines[0]);
        if (firstLineIdx !== -1) {
          errors.push(`Edit ${i + 1}: First line found but block doesn't match. Check whitespace/indentation.`);
        } else {
          errors.push(`Edit ${i + 1}: Could not find multi-line block starting with "${lines[0].slice(0, 50)}..."`);
        }
      }
      continue;
    }

    // Apply the edit
    const before = modified.slice(Math.max(0, startIndex - 30), startIndex);
    const after = modified.slice(startIndex + edit.oldText.length, Math.min(modified.length, startIndex + edit.oldText.length + 30));
    
    // Generate a contextual diff
    const oldLines = edit.oldText.split('\n');
    const newLines = edit.newText.split('\n');
    const contextLines = modified.slice(0, startIndex).split('\n').length;
    
    diffParts.push(`@@ line ${contextLines} @@`);
    for (const line of oldLines) {
      diffParts.push(`-${line}`);
    }
    for (const line of newLines) {
      if (line) diffParts.push(`+${line}`);
    }
    
    modified = modified.slice(0, startIndex) + edit.newText + modified.slice(startIndex + edit.oldText.length);
    linesChanged += oldLines.length;
  }

  if (errors.length > 0) {
    return { success: false, diff: '', errors };
  }

  return {
    success: true,
    diff: diffParts.join('\n'),
    result: modified,
    errors: [],
  };
}

/**
 * Find closest matching line for fuzzy suggestions.
 */
function findClosestMatch(content: string, target: string): { line: number; text: string } | null {
  const lines = content.split('\n');
  const targetWords = target.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  let bestMatch: { line: number; text: string; score: number } | null = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();
    const score = targetWords.filter(w => lowerLine.includes(w)).length;
    
    if (score > (bestMatch?.score ?? 0) && score >= Math.ceil(targetWords.length / 2)) {
      bestMatch = { line: i + 1, text: line, score };
    }
  }
  
  return bestMatch;
}

/**
 * Generate a unified diff between old and new content.
 */
export function generateUnifiedDiff(oldContent: string, newContent: string, filename: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  
  // Simple LCS-based diff
  const diff: string[] = [];
  diff.push(`--- ${filename}`);
  diff.push(`+++ ${filename}`);
  
  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }
  
  // Find common suffix
  let suffixLen = 0;
  while (suffixLen < oldLines.length - prefixLen && suffixLen < newLines.length - prefixLen &&
         oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
    suffixLen++;
  }
  
  const deletedLines = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const addedLines = newLines.slice(prefixLen, newLines.length - suffixLen);
  
  if (deletedLines.length === 0 && addedLines.length === 0) {
    return 'No changes';
  }
  
  const startLine = Math.max(1, prefixLen);
  const endLine = prefixLen + Math.max(deletedLines.length, addedLines.length);
  
  diff.push(`@@ -${startLine},${deletedLines.length} +${startLine},${addedLines.length} @@`);
  
  // Context before
  for (let i = Math.max(0, prefixLen - 3); i < prefixLen; i++) {
    diff.push(` ${oldLines[i]}`);
  }
  
  // Deleted lines
  for (const line of deletedLines) {
    diff.push(`-${line}`);
  }
  
  // Added lines
  for (const line of addedLines) {
    diff.push(`+${line}`);
  }
  
  // Context after
  for (let i = oldLines.length - suffixLen; i < Math.min(oldLines.length, oldLines.length - suffixLen + 3); i++) {
    diff.push(` ${oldLines[i]}`);
  }
  
  return diff.join('\n');
}

/**
 * Find symbol definitions in code files.
 */
export async function findDefinitions(
  repoFetcher: RepoFetcher,
  owner: string,
  repo: string,
  symbol: string,
  includeTests: boolean,
): Promise<string> {
  const tree = await repoFetcher.getTree(owner, repo);
  const codeFiles = tree.filter(isCodeFile).filter(f => includeTests || !isTestFile(f));
  
  const pattern = buildDefinitionPattern(symbol);
  const results: { file: string; line: number; snippet: string }[] = [];
  
  // Search in batches for efficiency
  const batchSize = 10;
  for (let i = 0; i < codeFiles.length && results.length < MAX_RESULTS; i += batchSize) {
    const batch = codeFiles.slice(i, i + batchSize);
    const files = await repoFetcher.fetchFiles(owner, repo, batch);
    
    for (const file of files) {
      const lines = file.content.split('\n');
      for (let j = 0; j < lines.length && results.length < MAX_RESULTS; j++) {
        if (pattern.test(lines[j])) {
          results.push({
            file: file.path,
            line: j + 1,
            snippet: lines[j].trim().slice(0, 100),
          });
        }
      }
    }
  }
  
  if (results.length === 0) {
    return `No definitions found for "${symbol}"`;
  }
  
  return results
    .map(r => `${r.file}:${r.line}\n  ${r.snippet}`)
    .join('\n\n');
}

/**
 * Find all references to a symbol in code files.
 */
export async function findReferences(
  repoFetcher: RepoFetcher,
  owner: string,
  repo: string,
  symbol: string,
  includeTests: boolean,
): Promise<string> {
  const tree = await repoFetcher.getTree(owner, repo);
  const codeFiles = tree.filter(isCodeFile).filter(f => includeTests || !isTestFile(f));
  
  // Match symbol as word boundary to avoid partial matches
  const regex = new RegExp(`\\b${escapeRegex(symbol)}\\b`, 'g');
  const results: { file: string; line: number; count: number }[] = [];
  
  const batchSize = 10;
  for (let i = 0; i < codeFiles.length; i += batchSize) {
    const batch = codeFiles.slice(i, i + batchSize);
    const files = await repoFetcher.fetchFiles(owner, repo, batch);
    
    for (const file of files) {
      const lines = file.content.split('\n');
      let fileCount = 0;
      
      for (let j = 0; j < lines.length; j++) {
        const matches = lines[j].match(regex);
        if (matches) {
          fileCount += matches.length;
        }
      }
      
      if (fileCount > 0) {
        results.push({ file: file.path, line: 1, count: fileCount });
      }
    }
  }
  
  if (results.length === 0) {
    return `No references found for "${symbol}"`;
  }
  
  results.sort((a, b) => a.file.localeCompare(b.file));
  return results
    .slice(0, MAX_RESULTS)
    .map(r => `${r.file} (${r.count} reference${r.count !== 1 ? 's' : ''})`)
    .join('\n');
}

/**
 * Analyze what a file imports.
 */
export async function analyzeImports(
  repoFetcher: RepoFetcher,
  owner: string,
  repo: string,
  filePath: string,
): Promise<string> {
  const files = await repoFetcher.fetchFiles(owner, repo, [filePath]);
  if (files.length === 0) {
    return `File not found: ${filePath}`;
  }
  
  const content = files[0].content;
  const lines = content.split('\n');
  const imports: { source: string; items: string[]; line: number }[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // ES6 imports: import { x } from 'y' or import x from 'y'
    const es6Match = line.match(/^import\s+(?:\{([^}]+)\}|\*\s+as\s+\w+|(\w+))\s+from\s+['"]([^'"]+)['"]/);
    if (es6Match) {
      const items = es6Match[1] ? es6Match[1].split(',').map(s => s.trim()) : [es6Match[2] || '*'];
      imports.push({ source: es6Match[3], items, line: i + 1 });
      continue;
    }
    
    // Dynamic imports: import('x')
    const dynamicMatch = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (dynamicMatch) {
      imports.push({ source: dynamicMatch[1], items: ['(dynamic)'], line: i + 1 });
      continue;
    }
    
    // CommonJS: require('x')
    const cjsMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (cjsMatch) {
      imports.push({ source: cjsMatch[1], items: ['(CommonJS)'], line: i + 1 });
      continue;
    }
    
    // Python imports
    const pyMatch = line.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/);
    if (pyMatch) {
      const source = pyMatch[1] || '(builtin)';
      const items = pyMatch[2].split(',').map(s => s.trim());
      imports.push({ source, items, line: i + 1 });
    }
    
    // Go imports (already extracted at top of file)
    const goMatch = line.match(/^import\s+(?:\(([^)]+)\)|["']([^"']+)["'])/);
    if (goMatch) {
      if (goMatch[2]) {
        imports.push({ source: goMatch[2], items: ['*'], line: i + 1 });
      }
    }
    
    // Rust uses
    const rustMatch = line.match(/^use\s+([^;]+);/);
    if (rustMatch) {
      imports.push({ source: rustMatch[1], items: ['*'], line: i + 1 });
    }
  }
  
  if (imports.length === 0) {
    return `No imports found in ${filePath}`;
  }
  
  return imports
    .map(i => `${i.line}: ${i.source} → ${i.items.slice(0, 3).join(', ')}${i.items.length > 3 ? '...' : ''}`)
    .join('\n');
}

/**
 * Find callers of a function.
 */
export async function findCallers(
  repoFetcher: RepoFetcher,
  owner: string,
  repo: string,
  symbol: string,
  includeTests: boolean,
): Promise<string> {
  const tree = await repoFetcher.getTree(owner, repo);
  const codeFiles = tree.filter(isCodeFile).filter(f => includeTests || !isTestFile(f));
  
  // Match function call patterns: symbol( or symbol(args)
  const callPattern = new RegExp(`\\b${escapeRegex(symbol)}\\s*\\(`, 'g');
  const results: { file: string; line: number; snippet: string }[] = [];
  
  const batchSize = 10;
  for (let i = 0; i < codeFiles.length && results.length < MAX_RESULTS; i += batchSize) {
    const batch = codeFiles.slice(i, i + batchSize);
    const files = await repoFetcher.fetchFiles(owner, repo, batch);
    
    for (const file of files) {
      const lines = file.content.split('\n');
      for (let j = 0; j < lines.length && results.length < MAX_RESULTS; j++) {
        if (callPattern.test(lines[j])) {
          results.push({
            file: file.path,
            line: j + 1,
            snippet: lines[j].trim().slice(0, 80),
          });
        }
      }
    }
  }
  
  if (results.length === 0) {
    return `No callers found for "${symbol}"`;
  }
  
  return results
    .map(r => `${r.file}:${r.line}\n  ${r.snippet}`)
    .join('\n\n');
}

/**
 * Find files that would be affected by changes to a given file.
 * This traces the import graph in reverse.
 */
export async function affectedFiles(
  repoFetcher: RepoFetcher,
  owner: string,
  repo: string,
  filePath: string,
): Promise<string> {
  const tree = await repoFetcher.getTree(owner, repo);
  const codeFiles = tree.filter(isCodeFile);
  
  // Get the module name from file path
  const moduleName = filePath.replace(/\.[^.]+$/, '').replace(/\/index$/, '');
  const moduleBasename = moduleName.split('/').pop() || moduleName;
  const modulePatterns = [
    new RegExp(`['"]\\.*/${escapeRegex(moduleBasename)}['"]`),
    new RegExp(`['"]\\.*/${escapeRegex(moduleName)}['"]`),
    new RegExp(`['"]${escapeRegex(moduleName)}['"]`),
  ];
  
  const affected: string[] = [];
  const seen = new Set<string>();
  seen.add(filePath);
  
  // Find files that import this module
  const batchSize = 10;
  for (let i = 0; i < codeFiles.length; i += batchSize) {
    const batch = codeFiles.slice(i, i + batchSize);
    const files = await repoFetcher.fetchFiles(owner, repo, batch);
    
    for (const file of files) {
      if (seen.has(file.path)) continue;
      
      for (const pattern of modulePatterns) {
        if (pattern.test(file.content)) {
          affected.push(file.path);
          seen.add(file.path);
          break;
        }
      }
    }
  }
  
  if (affected.length === 0) {
    return `No files import "${filePath}" directly`;
  }
  
  return `Files affected by changes to ${filePath}:\n${affected.map(f => `  ${f}`).join('\n')}`;
}

/**
 * Build regex pattern for finding symbol definitions.
 */
function buildDefinitionPattern(symbol: string): RegExp {
  const escaped = escapeRegex(symbol);
  // Match function/class/const/var/let definitions
  return new RegExp(
    `^(\\s*)(function\\s+${escaped}|const\\s+${escaped}|let\\s+${escaped}|var\\s+${escaped}|class\\s+${escaped}|interface\\s+${escaped}|type\\s+${escaped}|def\\s+${escaped}|fn\\s+${escaped}|func\\s+${escaped}|pub\\s+fn\\s+${escaped}|async\\s+${escaped}|${escaped}\\s*[<(])`,
    'm'
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTestFile(path: string): boolean {
  return /(^test|_test|\.test|\.spec|__tests__|tests?\/)/i.test(path);
}