import { spawn } from 'node:child_process';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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

/**
 * Execute dev tools (terminal, git, build) in the session workspace.
 */
export class DevToolExecutor {
  constructor(private sandboxDir: string) {}

  async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'run_terminal':
        return this.runTerminal(input);
      case 'git_command':
        return this.gitCommand(input);
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

  private async gitCommand(input: Record<string, unknown>): Promise<string> {
    const args = input.args;
    if (typeof args !== 'string' || args.trim().length === 0) {
      return 'Error: args must be a non-empty string';
    }
    if (args.length > 1000) {
      return 'Error: git args too long (max 1000 chars)';
    }

    // Configure git credential helper when GITHUB_TOKEN is available
    const extraEnv = await this.getGitCredentialEnv();

    // Split args for spawn — use shell to handle quoting
    return this.exec('bash', ['-c', `git ${args}`], GIT_TIMEOUT_MS, extraEnv);
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
   * When GITHUB_TOKEN is available, creates a GIT_ASKPASS script that
   * provides the token for HTTPS git operations (push, pull, clone).
   * The token is passed via environment variable to avoid writing it to disk.
   */
  private async getGitCredentialEnv(): Promise<Record<string, string>> {
    if (!config.GITHUB_TOKEN) return {};

    try {
      // Create a minimal askpass script that reads the token from an env var.
      // Git calls this for both username and password prompts — return the
      // token for both (GitHub accepts the token as the password with any username).
      const askpassPath = join(this.sandboxDir, '.git-askpass.sh');
      await writeFile(
        askpassPath,
        '#!/bin/sh\ncase "$1" in\n  *sername*) echo "x-access-token" ;;\n  *) echo "$GIT_AUTH_TOKEN" ;;\nesac\n',
        { mode: 0o700 },
      );

      return {
        GIT_ASKPASS: askpassPath,
        GIT_AUTH_TOKEN: config.GITHUB_TOKEN,
        GIT_TERMINAL_PROMPT: '0',
      };
    } catch (err) {
      logger.warn({ err }, 'Failed to set up git credentials');
      return {};
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
