import { spawn } from 'node:child_process';
import { access, readFile, readdir, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const DEV_TIMEOUT_MS = 60_000; // 60s for terminal/build commands
const GIT_TIMEOUT_MS = 30_000; // 30s for git commands
const MAX_OUTPUT = 15_000; // 15KB output cap

/** Blocked commands that could damage the host or escape sandbox. */
const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/(?!\s|$)/i,     // rm -rf / (root)
  /\b(?:shutdown|reboot|halt)\b/i,
  /\b(?:mkfs|fdisk|dd\s+if=)\b/i,
  /\b(?:iptables|ufw)\b/i,
  />\s*\/dev\//i,                   // redirect to devices
  /\|\s*(?:sh|bash)\s*$/i,         // pipe to shell (basic check)
];

/** Shell metacharacters that could allow command injection when interpolated into bash -c. */
const SHELL_INJECTION_CHARS = /[;|&`$(){}!<>\n\r]/;

/** Cached GitHub user identity resolved from GITHUB_TOKEN. */
let cachedGitHubUser: { name: string; email: string } | null = null;

/** All git tool names for routing. */
export const GIT_TOOL_NAMES = new Set([
  'git_status', 'git_diff', 'git_log', 'git_add', 'git_commit',
  'git_push', 'git_pull', 'git_branch', 'git_checkout', 'git_clone',
]);

/**
 * Execute dev tools (terminal, git, build) in the session workspace.
 */
export class DevToolExecutor {
  constructor(private sandboxDir: string) {}

  async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    if (GIT_TOOL_NAMES.has(toolName)) {
      return this.gitTool(toolName, input);
    }
    switch (toolName) {
      case 'run_terminal':
        return this.runTerminal(input);
      case 'build_project':
        return this.buildProject(input);
      default:
        return `Unknown dev tool: ${toolName}`;
    }
  }

  private async runTerminal(input: Record<string, unknown>): Promise<string> {
    const command = input.command;
    if (typeof command !== 'string' || command.trim().length === 0) {
      return 'Error: command must be a non-empty string';
    }
    if (command.length > 2000) {
      return 'Error: command too long (max 2000 chars)';
    }

    const blocked = BLOCKED_PATTERNS.find((p) => p.test(command));
    if (blocked) {
      return 'Error: command blocked for safety reasons';
    }

    return this.exec('bash', ['-c', command], DEV_TIMEOUT_MS);
  }

  /**
   * Route a specific git_* tool to the correct git subcommand.
   * Each tool has its own parameter shape, so we build the git args here.
   */
  private async gitTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    let gitArgs: string;

    switch (toolName) {
      case 'git_status': {
        const flags = typeof input.flags === 'string' ? input.flags.trim() : '';
        gitArgs = `status${flags ? ' ' + flags : ''}`;
        break;
      }
      case 'git_diff': {
        const target = typeof input.target === 'string' ? input.target.trim() : '';
        gitArgs = `diff${target ? ' ' + target : ''}`;
        break;
      }
      case 'git_log': {
        const args = typeof input.args === 'string' ? input.args.trim() : '--oneline -20';
        gitArgs = `log ${args}`;
        break;
      }
      case 'git_add': {
        const files = typeof input.files === 'string' ? input.files.trim() : '';
        if (!files) return 'Error: files parameter is required (e.g. "." or "src/index.ts")';
        gitArgs = `add ${files}`;
        break;
      }
      case 'git_commit': {
        const message = typeof input.message === 'string' ? input.message.trim() : '';
        if (!message) return 'Error: message parameter is required';
        // Use -- to prevent message from being interpreted as flags.
        // We pass via -m; the message is shell-escaped below.
        gitArgs = `commit -m "${message.replace(/"/g, '\\"')}"`;
        break;
      }
      case 'git_push': {
        const args = typeof input.args === 'string' ? input.args.trim() : '';
        gitArgs = `push${args ? ' ' + args : ''}`;
        break;
      }
      case 'git_pull': {
        const args = typeof input.args === 'string' ? input.args.trim() : '';
        gitArgs = `pull${args ? ' ' + args : ''}`;
        break;
      }
      case 'git_branch': {
        const args = typeof input.args === 'string' ? input.args.trim() : '';
        gitArgs = `branch${args ? ' ' + args : ''}`;
        break;
      }
      case 'git_checkout': {
        const target = typeof input.target === 'string' ? input.target.trim() : '';
        if (!target) return 'Error: target parameter is required (branch name or file path)';
        gitArgs = `checkout ${target}`;
        break;
      }
      case 'git_clone': {
        const url = typeof input.url === 'string' ? input.url.trim() : '';
        if (!url) return 'Error: url parameter is required';
        if (!url.startsWith('https://')) return 'Error: url must start with https://';
        // Inject auth token into clone URL if available
        const cloneUrl = config.GITHUB_TOKEN
          ? url.replace('https://github.com/', `https://x-access-token:${config.GITHUB_TOKEN}@github.com/`)
          : url;
        gitArgs = `clone --depth 1 ${cloneUrl} .`;
        break;
      }
      default:
        return `Unknown git tool: ${toolName}`;
    }

    return this.execGitCommand(gitArgs);
  }

  /**
   * Execute a constructed git command string with proper auth and identity.
   */
  private async execGitCommand(gitArgs: string): Promise<string> {
    if (gitArgs.length > 2000) {
      return 'Error: git command too long';
    }

    // Block shell metacharacters that could allow command injection
    // (except for quotes and hyphens which are needed for commit messages and flags)
    // We allow: - _ . / ~ @ = " ' : (needed for URLs, flags, messages, refs)
    // We block: ; | & ` $ () {} ! < > \n \r (shell injection vectors)
    const DANGEROUS_CHARS = /[;|&`$(){}!<>\n\r]/;
    if (DANGEROUS_CHARS.test(gitArgs)) {
      return 'Error: git command contains disallowed shell characters';
    }

    const blocked = BLOCKED_PATTERNS.find((p) => p.test(gitArgs));
    if (blocked) {
      return 'Error: command blocked for safety reasons';
    }

    // Configure git credential helper when GITHUB_TOKEN is available
    const { env: extraEnv, cleanup } = await this.getGitCredentialEnv();

    // Set git author/committer identity
    const { name: gitName, email: gitEmail } = await this.getGitIdentity();
    extraEnv['GIT_AUTHOR_NAME'] = gitName;
    extraEnv['GIT_COMMITTER_NAME'] = gitName;
    extraEnv['GIT_AUTHOR_EMAIL'] = gitEmail;
    extraEnv['GIT_COMMITTER_EMAIL'] = gitEmail;

    try {
      return await this.exec('bash', ['-c', `git ${gitArgs}`], GIT_TIMEOUT_MS, extraEnv);
    } finally {
      await cleanup();
    }
  }

  /**
   * Determine git author name/email for commits.
   * Priority: explicit config > GitHub token user > auto-derived from active model.
   */
  private async getGitIdentity(): Promise<{ name: string; email: string }> {
    if (config.GIT_AUTHOR_NAME && config.GIT_AUTHOR_EMAIL) {
      return { name: config.GIT_AUTHOR_NAME, email: config.GIT_AUTHOR_EMAIL };
    }

    // Try to resolve identity from GitHub token (cached after first call)
    if (config.GITHUB_TOKEN && !cachedGitHubUser) {
      try {
        const res = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${config.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
          },
        });
        if (res.ok) {
          const user = await res.json() as { login: string; name: string | null; id: number };
          cachedGitHubUser = {
            name: user.name || user.login,
            // Use the GitHub noreply email so the commit is linked to the account
            email: `${user.id}+${user.login}@users.noreply.github.com`,
          };
          logger.info(`Git identity resolved from GitHub token: ${cachedGitHubUser.name} <${cachedGitHubUser.email}>`);
        }
      } catch {
        // Network error — fall through to model-based default
      }
    }

    if (cachedGitHubUser) {
      return {
        name: config.GIT_AUTHOR_NAME || cachedGitHubUser.name,
        email: config.GIT_AUTHOR_EMAIL || cachedGitHubUser.email,
      };
    }

    const model = config.ANTHROPIC_MODEL;

    let name: string;
    if (model === 'claude-code' || model.startsWith('claude-code-') || model.startsWith('claude-')) {
      name = 'Claude';
    } else if (model.startsWith('ollama/')) {
      name = `Ollama (${model.replace(/^ollama\//, '')})`;
    } else if (model.startsWith('gemini-')) {
      name = 'Gemini';
    } else {
      name = 'AI Assistant';
    }

    return {
      name: config.GIT_AUTHOR_NAME || name,
      email: config.GIT_AUTHOR_EMAIL || 'noreply@users.noreply.github.com',
    };
  }

  private async buildProject(input: Record<string, unknown>): Promise<string> {
    const action = (typeof input.action === 'string' && input.action.trim()) || 'build';

    // Auto-detect project type and map action to command
    const command = await this.detectBuildCommand(action);
    if (!command) {
      return `Error: Could not detect project type in workspace. Supported: package.json, Makefile, Cargo.toml, pyproject.toml, go.mod. Use run_terminal for custom commands.`;
    }

    return this.exec('bash', ['-c', command], DEV_TIMEOUT_MS);
  }

  private async detectBuildCommand(action: string): Promise<string | null> {
    const knownActions = ['build', 'test', 'lint', 'typecheck'];
    if (!knownActions.includes(action)) {
      return null; // reject unknown actions — use run_terminal for custom commands
    }

    // Check for package.json (Node.js)
    if (await this.fileExists('package.json')) {
      const pm = await this.detectPackageManager();
      const pkgJson = await this.readJson('package.json');
      const scripts = pkgJson?.scripts || {};

      switch (action) {
        case 'build':
          if (scripts.build) return `${pm} run build`;
          return `${pm} run build 2>&1 || echo "No build script found in package.json"`;
        case 'test':
          if (scripts.test) return `${pm} run test`;
          return `echo "No test script found in package.json"`;
        case 'lint':
          if (scripts.lint) return `${pm} run lint`;
          return `echo "No lint script found in package.json"`;
        case 'typecheck':
          if (scripts.typecheck) return `${pm} run typecheck`;
          if (scripts['type-check']) return `${pm} run type-check`;
          return `npx tsc --noEmit`;
      }
    }

    // Makefile
    if (await this.fileExists('Makefile')) {
      switch (action) {
        case 'build': return 'make';
        case 'test': return 'make test';
        case 'lint': return 'make lint';
        default: return `make ${action}`;
      }
    }

    // Cargo.toml (Rust)
    if (await this.fileExists('Cargo.toml')) {
      switch (action) {
        case 'build': return 'cargo build';
        case 'test': return 'cargo test';
        case 'lint': return 'cargo clippy';
        case 'typecheck': return 'cargo check';
      }
    }

    // pyproject.toml (Python)
    if (await this.fileExists('pyproject.toml')) {
      switch (action) {
        case 'build': return 'pip install -e .';
        case 'test': return 'pytest';
        case 'lint': return 'ruff check .';
        case 'typecheck': return 'mypy .';
      }
    }

    // go.mod (Go)
    if (await this.fileExists('go.mod')) {
      switch (action) {
        case 'build': return 'go build ./...';
        case 'test': return 'go test ./...';
        case 'lint': return 'golangci-lint run';
        case 'typecheck': return 'go vet ./...';
      }
    }

    return null;
  }

  private async detectPackageManager(): Promise<string> {
    if (await this.fileExists('pnpm-lock.yaml')) return 'pnpm';
    if (await this.fileExists('yarn.lock')) return 'yarn';
    if (await this.fileExists('bun.lockb')) return 'bun';
    return 'npm';
  }

  private async fileExists(relativePath: string): Promise<boolean> {
    try {
      await access(join(this.sandboxDir, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  private async readJson(relativePath: string): Promise<any | null> {
    try {
      const content = await readFile(join(this.sandboxDir, relativePath), 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Build environment variables for git credential authentication.
   * When GITHUB_TOKEN is available, creates a temporary GIT_ASKPASS script
   * that embeds the token directly (not via env var, to prevent sandbox scripts
   * from reading it via `env` or `printenv`). The askpass script is deleted
   * after the git command completes.
   */
  private async getGitCredentialEnv(): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
    if (!config.GITHUB_TOKEN) return { env: {}, cleanup: async () => {} };

    try {
      // Write askpass script to OS temp dir, NOT the sandbox — sandbox is accessible
      // to AI-generated scripts which could read the token during the race window.
      const askpassPath = join(tmpdir(), `.git-askpass-${Date.now()}-${process.pid}.sh`);
      // Embed the token directly in the script so it's not visible in env.
      // The script is created with restricted permissions and deleted after use.
      const token = config.GITHUB_TOKEN;
      await writeFile(
        askpassPath,
        `#!/bin/sh\ncase "$1" in\n  *sername*) echo "x-access-token" ;;\n  *) echo "${token}" ;;\nesac\n`,
        { mode: 0o700 },
      );

      return {
        env: {
          GIT_ASKPASS: askpassPath,
          GIT_TERMINAL_PROMPT: '0',
        },
        cleanup: async () => {
          try { await unlink(askpassPath); } catch { /* ignore */ }
        },
      };
    } catch (err) {
      logger.warn({ err }, 'Failed to set up git credentials');
      return { env: {}, cleanup: async () => {} };
    }
  }

  private exec(cmd: string, args: string[], timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;

      const proc = spawn(cmd, args, {
        cwd: this.sandboxDir,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: this.sandboxDir,
          ...extraEnv,
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
        resolve(this.formatOutput(stdout, stderr, code, timedOut, timeoutMs));
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        resolve(`Error: ${err.message}`);
      });
    });
  }

  private formatOutput(
    stdout: string,
    stderr: string,
    exitCode: number | null,
    timedOut: boolean,
    timeoutMs: number,
  ): string {
    const parts: string[] = [];

    if (timedOut) {
      parts.push(`[Timed out after ${timeoutMs / 1000}s]`);
    }

    // Combine output — most terminal commands mix stdout/stderr
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    if (combined) {
      const truncated = combined.length >= MAX_OUTPUT;
      parts.push(combined + (truncated ? '\n[output truncated]' : ''));
    } else {
      parts.push('[No output]');
    }

    if (exitCode !== null && exitCode !== 0) {
      parts.push(`Exit code: ${exitCode}`);
    }

    return parts.join('\n');
  }
}

/**
 * Ensure the sandbox directory is set up as a git workspace for the given repo.
 * - If empty: shallow clone the repo
 * - If already a git repo: fetch & pull to get latest changes
 * - Sets up auth if GITHUB_TOKEN is available
 *
 * Called at session startup so the model always sees a valid git repo.
 */
export async function ensureGitWorkspace(
  sandboxDir: string,
  repoUrl: string,
): Promise<{ ok: boolean; message: string }> {
  const execGit = (args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number | null }> => {
    return new Promise((resolve) => {
      const env: Record<string, string | undefined> = { ...process.env, HOME: sandboxDir };
      // Set up auth
      if (config.GITHUB_TOKEN) {
        env['GIT_TERMINAL_PROMPT'] = '0';
      }
      const proc = spawn('git', args, {
        cwd: sandboxDir,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ stdout, stderr, code }));
      proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }));
    });
  };

  try {
    const files = await readdir(sandboxDir);

    // Check if already a git repo
    const isGitRepo = files.includes('.git');

    if (isGitRepo) {
      // Already cloned — pull latest
      logger.info({ sandboxDir, repoUrl }, 'Workspace already has git repo, pulling latest');
      const result = await execGit(['pull', '--ff-only'], 30_000);
      if (result.code === 0) {
        return { ok: true, message: 'Pulled latest changes' };
      }
      // Pull failed (diverged, etc.) — still usable, just warn
      logger.warn({ stderr: result.stderr, sandboxDir }, 'Git pull failed, workspace may be stale');
      return { ok: true, message: 'Workspace has existing repo (pull failed, using as-is)' };
    }

    if (files.length > 0) {
      // Directory has files but no .git — can't clone into it
      logger.warn({ sandboxDir, fileCount: files.length }, 'Workspace has files but is not a git repo');
      return { ok: false, message: 'Workspace has existing files but is not a git repo' };
    }

    // Empty directory — clone
    const cloneUrl = config.GITHUB_TOKEN
      ? repoUrl.replace('https://github.com/', `https://x-access-token:${config.GITHUB_TOKEN}@github.com/`)
      : repoUrl;

    logger.info({ repoUrl, sandboxDir }, 'Cloning repo into workspace');
    const result = await execGit(['clone', '--depth', '1', cloneUrl, '.']);
    if (result.code === 0) {
      return { ok: true, message: 'Repository cloned successfully' };
    }

    logger.warn({ stderr: result.stderr, code: result.code, repoUrl }, 'Git clone failed');
    return { ok: false, message: `Clone failed: ${result.stderr.slice(0, 200)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sandboxDir, repoUrl }, 'ensureGitWorkspace failed');
    return { ok: false, message: `Workspace setup error: ${msg}` };
  }
}
