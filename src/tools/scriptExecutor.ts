import { spawn } from 'node:child_process';
import { writeFile, readFile, unlink, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { join, normalize, resolve, relative, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const SANDBOX_BASE = join(tmpdir(), 'discord-agent-sandbox');
const MAX_OUTPUT = 10_000; // 10KB max output
const MAX_FILE_SIZE = 100_000; // 100KB max file read
const MAX_FILES_PER_SESSION = 50;

interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const LANGUAGE_CONFIG: Record<string, { ext: string; cmd: string; args?: string[] }> = {
  python: { ext: '.py', cmd: 'python3' },
  javascript: { ext: '.js', cmd: 'node' },
  bash: { ext: '.sh', cmd: 'bash' },
  sh: { ext: '.sh', cmd: 'sh' },
  ruby: { ext: '.rb', cmd: 'ruby' },
  perl: { ext: '.pl', cmd: 'perl' },
  typescript: { ext: '.ts', cmd: 'npx', args: ['tsx'] },
};

/**
 * Get or create a per-session sandbox directory.
 * Each session gets an isolated workspace for file operations.
 */
export async function getSandboxDir(sessionId?: string): Promise<string> {
  const dir = sessionId
    ? join(SANDBOX_BASE, `session_${sessionId}`)
    : join(SANDBOX_BASE, `tmp_${randomBytes(8).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Validate that a path stays within the sandbox.
 */
function safePath(sandboxDir: string, userPath: string): string | null {
  const resolved = resolve(sandboxDir, normalize(userPath));
  const rel = relative(sandboxDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

/**
 * Execute a script in a sandboxed subprocess with timeout and output limits.
 */
export async function executeScript(
  language: string,
  code: string,
  sandboxDir?: string,
): Promise<string> {
  if (!config.ENABLE_SCRIPT_EXECUTION) {
    return 'Error: Script execution is disabled. An admin can enable it with `/config set ENABLE_SCRIPT_EXECUTION true`.';
  }

  const lang = language.toLowerCase().trim();
  const langConfig = LANGUAGE_CONFIG[lang];
  if (!langConfig) {
    return `Error: Unsupported language "${language}". Supported: ${Object.keys(LANGUAGE_CONFIG).join(', ')}`;
  }

  const workDir = sandboxDir || await getSandboxDir();
  const id = randomBytes(8).toString('hex');
  const filename = `script_${id}${langConfig.ext}`;
  const filepath = join(workDir, filename);

  try {
    await writeFile(filepath, code, 'utf-8');

    const result = await runProcess(
      langConfig.cmd,
      [...(langConfig.args || []), filepath],
      config.SCRIPT_TIMEOUT_MS,
      workDir,
    );

    return formatResult(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, language, scriptId: id }, 'Script execution error');
    return `Error executing script: ${message}`;
  } finally {
    // Clean up the script file but leave other workspace files
    unlink(filepath).catch(() => {});
  }
}

/**
 * Write a file to the sandbox workspace.
 */
export async function sandboxWriteFile(
  path: string,
  content: string,
  sandboxDir: string,
): Promise<string> {
  if (!config.ENABLE_SCRIPT_EXECUTION) {
    return 'Error: Script execution is disabled.';
  }

  const resolved = safePath(sandboxDir, path);
  if (!resolved) {
    return 'Error: Path escapes the sandbox directory.';
  }

  try {
    // Create parent directories
    const parentDir = dirname(resolved);
    await mkdir(parentDir, { recursive: true });

    await writeFile(resolved, content, 'utf-8');
    return `File written: ${path} (${content.length} bytes)`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error writing file: ${message}`;
  }
}

/**
 * Read a file from the sandbox workspace.
 */
export async function sandboxReadFile(
  path: string,
  sandboxDir: string,
): Promise<string> {
  if (!config.ENABLE_SCRIPT_EXECUTION) {
    return 'Error: Script execution is disabled.';
  }

  const resolved = safePath(sandboxDir, path);
  if (!resolved) {
    return 'Error: Path escapes the sandbox directory.';
  }

  try {
    const content = await readFile(resolved, 'utf-8');
    if (content.length > MAX_FILE_SIZE) {
      return content.slice(0, MAX_FILE_SIZE) + `\n\n[Truncated — file is ${Math.round(content.length / 1000)}KB]`;
    }
    return content;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error reading file: ${message}`;
  }
}

/**
 * List files in the sandbox workspace.
 */
export async function sandboxListFiles(
  path: string,
  sandboxDir: string,
): Promise<string> {
  if (!config.ENABLE_SCRIPT_EXECUTION) {
    return 'Error: Script execution is disabled.';
  }

  const resolved = safePath(sandboxDir, path || '.');
  if (!resolved) {
    return 'Error: Path escapes the sandbox directory.';
  }

  try {
    const entries = await readdir(resolved);
    const results: string[] = [];
    for (const entry of entries.slice(0, MAX_FILES_PER_SESSION)) {
      try {
        const s = await stat(join(resolved, entry));
        results.push(s.isDirectory() ? `${entry}/` : entry);
      } catch {
        results.push(entry);
      }
    }
    return results.length > 0 ? results.join('\n') : '[Empty directory]';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error listing directory: ${message}`;
  }
}

/**
 * Clean up a session's sandbox directory.
 */
export async function cleanupSandbox(sessionId: string): Promise<void> {
  const dir = join(SANDBOX_BASE, `session_${sessionId}`);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Clean up stale temporary sandbox directories older than 1 hour.
 */
export async function cleanupStaleSandboxes(): Promise<number> {
  try {
    const entries = await readdir(SANDBOX_BASE);
    let cleaned = 0;
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.startsWith('tmp_')) continue;
      try {
        const s = await stat(join(SANDBOX_BASE, entry));
        if (s.mtimeMs < oneHourAgo) {
          await rm(join(SANDBOX_BASE, entry), { recursive: true, force: true });
          cleaned++;
        }
      } catch { /* ignore */ }
    }
    return cleaned;
  } catch {
    return 0;
  }
}

function runProcess(cmd: string, args: string[], timeoutMs: number, cwd: string): Promise<ScriptResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    const proc = spawn(cmd, args, {
      cwd,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] || '/usr/local/bin:/usr/bin:/bin',
        HOME: cwd,
        LANG: 'en_US.UTF-8',
      },
    });

    proc.stdout.on('data', (data: Buffer) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += data.toString().slice(0, MAX_OUTPUT - stdout.length);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += data.toString().slice(0, MAX_OUTPUT - stderr.length);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (!killed) {
        killed = true;
        proc.kill('SIGKILL');
      }
    }, timeoutMs);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr || err.message,
        exitCode: 1,
        timedOut: false,
      });
    });
  });
}

function formatResult(result: ScriptResult): string {
  const parts: string[] = [];

  if (result.timedOut) {
    parts.push(`[Timed out after ${config.SCRIPT_TIMEOUT_MS / 1000}s]`);
  }

  if (result.stdout) {
    const truncated = result.stdout.length >= MAX_OUTPUT;
    parts.push(`--- stdout ---\n${result.stdout}${truncated ? '\n[truncated]' : ''}`);
  }

  if (result.stderr) {
    const truncated = result.stderr.length >= MAX_OUTPUT;
    parts.push(`--- stderr ---\n${result.stderr}${truncated ? '\n[truncated]' : ''}`);
  }

  if (!result.stdout && !result.stderr) {
    parts.push('[No output]');
  }

  if (result.exitCode !== null && result.exitCode !== 0) {
    parts.push(`Exit code: ${result.exitCode}`);
  }

  return parts.join('\n\n');
}
