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

export const WORKSPACE_TOOL_NAMES = new Set(['patch_file']);
export const ADVANCED_TOOL_NAMES = new Set(['http_request', 'find_replace_all', 'download_file', 'run_tests']);

/**
 * Execute dev tools (terminal, git, build) in the session workspace.
 */
export class DevToolExecutor {
  constructor(private sandboxDir: string) {}

  async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    if (GIT_TOOL_NAMES.has(toolName)) {
      return this.gitTool(toolName, input);
    }
    if (WORKSPACE_TOOL_NAMES.has(toolName)) {
      return this.workspaceTool(toolName, input);
    }
    if (ADVANCED_TOOL_NAMES.has(toolName)) {
      return this.advancedTool(toolName, input);
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

  /**
   * Handle workspace file operations (patch_file).
   */
  private async workspaceTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    if (toolName === 'patch_file') {
      return this.patchFile(input);
    }
    return `Unknown workspace tool: ${toolName}`;
  }

  /**
   * Apply surgical SEARCH/REPLACE edits to a file in the git workspace.
   */
  private async patchFile(input: Record<string, unknown>): Promise<string> {
    const path = input.path;
    const editsStr = input.edits;
    if (typeof path !== 'string' || path.length === 0) {
      return 'Error: path must be a non-empty string';
    }
    if (typeof editsStr !== 'string' || editsStr.length === 0) {
      return 'Error: edits must be a JSON array string';
    }

    // Prevent path traversal
    if (path.includes('..') || path.startsWith('/')) {
      return 'Error: path must be relative and cannot contain ".."';
    }

    const { editFile } = await import('./fileEditor.js');
    const result = await editFile(path, editsStr, this.sandboxDir);
    return result.message;
  }

  /**
   * Handle advanced tools (http_request, find_replace_all, download_file, run_tests).
   */
  private async advancedTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'http_request': return this.httpRequest(input);
      case 'find_replace_all': return this.findReplaceAll(input);
      case 'download_file': return this.downloadFile(input);
      case 'run_tests': return this.runTests(input);
      default: return `Unknown advanced tool: ${toolName}`;
    }
  }

  /**
   * Make an HTTP request and return structured results.
   */
  private async httpRequest(input: Record<string, unknown>): Promise<string> {
    const url = input.url;
    if (typeof url !== 'string' || !url.startsWith('http')) {
      return 'Error: url must start with http:// or https://';
    }

    const method = (typeof input.method === 'string' ? input.method.toUpperCase() : 'GET');
    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    if (!validMethods.includes(method)) {
      return `Error: method must be one of: ${validMethods.join(', ')}`;
    }

    let headers: Record<string, string> = {};
    if (typeof input.headers === 'string') {
      try {
        headers = JSON.parse(input.headers);
      } catch {
        return 'Error: headers must be a valid JSON object';
      }
    }

    const body = typeof input.body === 'string' ? input.body : undefined;

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: (method !== 'GET' && method !== 'HEAD') ? body : undefined,
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
      });

      const respHeaders: string[] = [];
      resp.headers.forEach((value, key) => {
        respHeaders.push(`${key}: ${value}`);
      });

      let respBody: string;
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          const json = await resp.json();
          respBody = JSON.stringify(json, null, 2);
        } catch {
          respBody = await resp.text();
        }
      } else {
        respBody = await resp.text();
      }

      // Truncate large responses
      if (respBody.length > 30_000) {
        respBody = respBody.slice(0, 30_000) + '\n\n[Response truncated — 30KB limit]';
      }

      return [
        `**${resp.status} ${resp.statusText}**`,
        '',
        '**Response Headers:**',
        respHeaders.slice(0, 20).join('\n'),
        '',
        '**Body:**',
        respBody,
      ].join('\n');
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return 'Error: Request timed out after 30 seconds';
      }
      return `Error: ${err.message || String(err)}`;
    }
  }

  /**
   * Find and replace across multiple files in the workspace.
   */
  private async findReplaceAll(input: Record<string, unknown>): Promise<string> {
    const search = input.search;
    const replace = input.replace;
    if (typeof search !== 'string' || search.length === 0) return 'Error: search must be a non-empty string';
    if (typeof replace !== 'string') return 'Error: replace must be a string';

    const globPattern = typeof input.glob === 'string' ? input.glob : '**/*';
    const isRegex = input.is_regex === true;

    try {
      let pattern: RegExp;
      if (isRegex) {
        pattern = new RegExp(search, 'g');
      } else {
        // Escape for literal match
        pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      }

      // Use find to get matching files
      const { execSync } = await import('node:child_process');
      const findCmd = `find . -type f -name "${globPattern.replace(/\*\*\//g, '').replace(/"/g, '')}" 2>/dev/null | head -500`;
      // Use a more reliable approach: grep for files containing the search string
      const grepCmd = isRegex
        ? `grep -rl -E "${search.replace(/"/g, '\\"')}" --include="${globPattern.replace(/\*\*\//g, '')}" . 2>/dev/null | head -200`
        : `grep -rl -F "${search.replace(/"/g, '\\"')}" --include="${globPattern.replace(/\*\*\//g, '')}" . 2>/dev/null | head -200`;

      let filePaths: string[];
      try {
        const out = execSync(grepCmd, { cwd: this.sandboxDir, encoding: 'utf-8', timeout: 15_000 });
        filePaths = out.trim().split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));
      } catch {
        return 'No files matched the search pattern.';
      }

      if (filePaths.length === 0) return 'No files matched the search pattern.';

      let totalReplacements = 0;
      const changes: string[] = [];

      for (const filePath of filePaths) {
        const fullPath = join(this.sandboxDir, filePath);
        try {
          const content = await readFile(fullPath, 'utf-8');
          const matches = content.match(pattern);
          if (!matches || matches.length === 0) continue;

          const newContent = content.replace(pattern, replace as string);
          if (newContent === content) continue;

          await writeFile(fullPath, newContent, 'utf-8');
          totalReplacements += matches.length;
          changes.push(`${filePath}: ${matches.length} replacement(s)`);
        } catch {
          // Skip binary or unreadable files
        }
      }

      if (totalReplacements === 0) return 'Search pattern found in files but no replacements were made (pattern may not match with regex flags).';

      return [
        `**${totalReplacements} replacement(s) across ${changes.length} file(s):**`,
        '',
        ...changes,
        '',
        'Use `git_diff` to review changes.',
      ].join('\n');
    } catch (err: any) {
      return `Error: ${err.message || String(err)}`;
    }
  }

  /**
   * Download a file from URL into the workspace.
   */
  private async downloadFile(input: Record<string, unknown>): Promise<string> {
    const url = input.url;
    const path = input.path;
    if (typeof url !== 'string' || !url.startsWith('http')) {
      return 'Error: url must start with http:// or https://';
    }
    if (typeof path !== 'string' || path.length === 0) {
      return 'Error: path must be a non-empty string';
    }
    if (path.includes('..') || path.startsWith('/')) {
      return 'Error: path must be relative and cannot contain ".."';
    }

    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(60_000),
        redirect: 'follow',
      });

      if (!resp.ok) {
        return `Error: HTTP ${resp.status} ${resp.statusText}`;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const maxSize = 10 * 1024 * 1024; // 10MB
      if (buffer.length > maxSize) {
        return `Error: File too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB, max 10MB)`;
      }

      const fullPath = join(this.sandboxDir, path);
      const { dirname } = await import('node:path');
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, buffer);

      return `Downloaded ${(buffer.length / 1024).toFixed(1)}KB to \`${path}\``;
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return 'Error: Download timed out after 60 seconds';
      }
      return `Error: ${err.message || String(err)}`;
    }
  }

  /**
   * Run tests with structured result parsing.
   */
  private async runTests(input: Record<string, unknown>): Promise<string> {
    const file = typeof input.file === 'string' ? input.file.trim() : '';
    const grep = typeof input.grep === 'string' ? input.grep.trim() : '';

    // Detect test framework and build command
    let cmd: string | null = null;
    let parser: 'jest' | 'vitest' | 'pytest' | 'go' | 'cargo' | 'generic' = 'generic';

    if (await this.fileExists('package.json')) {
      const pkgJson = await this.readJson('package.json');
      const scripts = pkgJson?.scripts || {};
      const deps = { ...pkgJson?.dependencies, ...pkgJson?.devDependencies };
      const pm = await this.detectPackageManager();

      if (deps['vitest'] || scripts.test?.includes('vitest')) {
        parser = 'vitest';
        cmd = `npx vitest run --reporter=verbose`;
        if (file) cmd += ` ${file}`;
        if (grep) cmd += ` -t "${grep}"`;
      } else if (deps['jest'] || scripts.test?.includes('jest')) {
        parser = 'jest';
        cmd = `npx jest --verbose --no-coverage`;
        if (file) cmd += ` ${file}`;
        if (grep) cmd += ` -t "${grep}"`;
      } else if (scripts.test) {
        cmd = `${pm} run test`;
        if (file) cmd += ` -- ${file}`;
      }
    } else if (await this.fileExists('pyproject.toml') || await this.fileExists('pytest.ini') || await this.fileExists('setup.py')) {
      parser = 'pytest';
      cmd = `python -m pytest -v`;
      if (file) cmd += ` ${file}`;
      if (grep) cmd += ` -k "${grep}"`;
    } else if (await this.fileExists('go.mod')) {
      parser = 'go';
      cmd = `go test -v ./...`;
      if (file) cmd += ` -run "${file}"`;
      if (grep) cmd += ` -run "${grep}"`;
    } else if (await this.fileExists('Cargo.toml')) {
      parser = 'cargo';
      cmd = `cargo test`;
      if (grep) cmd += ` ${grep}`;
      cmd += ` -- --nocapture`;
    }

    if (!cmd) {
      return 'Error: Could not detect test framework. Supported: vitest, jest, pytest, go test, cargo test. Use `run_terminal` for custom test commands.';
    }

    const raw = await this.exec('bash', ['-c', cmd], 120_000); // 2 min timeout for tests

    // Parse structured results from the output
    return this.parseTestResults(raw, parser);
  }

  private parseTestResults(raw: string, parser: string): string {
    const lines = raw.split('\n');
    const passed: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    let currentFailure = '';

    for (const line of lines) {
      const trimmed = line.trim();

      // Jest / Vitest patterns
      if (trimmed.match(/^\s*[✓✔√]\s+/) || trimmed.match(/^\s*✓\s+/) || trimmed.match(/^\s*PASS\s+/)) {
        passed.push(trimmed);
      } else if (trimmed.match(/^\s*[✗✘×]\s+/) || trimmed.match(/^\s*✕\s+/) || trimmed.match(/^\s*FAIL\s+/)) {
        if (currentFailure) failed.push(currentFailure);
        currentFailure = trimmed;
      } else if (trimmed.match(/^\s*-\s+/) && trimmed.includes('skipped')) {
        skipped.push(trimmed);
      }
      // Pytest patterns
      else if (trimmed.match(/PASSED$/)) {
        passed.push(trimmed);
      } else if (trimmed.match(/FAILED$/)) {
        if (currentFailure) failed.push(currentFailure);
        currentFailure = trimmed;
      } else if (trimmed.match(/SKIPPED$/)) {
        skipped.push(trimmed);
      }
      // Go test patterns
      else if (trimmed.startsWith('--- PASS:')) {
        passed.push(trimmed);
      } else if (trimmed.startsWith('--- FAIL:')) {
        if (currentFailure) failed.push(currentFailure);
        currentFailure = trimmed;
      } else if (trimmed.startsWith('--- SKIP:')) {
        skipped.push(trimmed);
      }
      // Cargo test patterns
      else if (trimmed.match(/^test .+ \.\.\. ok$/)) {
        passed.push(trimmed);
      } else if (trimmed.match(/^test .+ \.\.\. FAILED$/)) {
        if (currentFailure) failed.push(currentFailure);
        currentFailure = trimmed;
      }
      // Accumulate failure details
      else if (currentFailure && trimmed.length > 0) {
        currentFailure += '\n' + line;
      }
    }
    if (currentFailure) failed.push(currentFailure);

    const total = passed.length + failed.length + skipped.length;
    const summary = [
      `**Test Results: ${failed.length === 0 ? 'ALL PASSED' : `${failed.length} FAILED`}**`,
      `Total: ${total} | Passed: ${passed.length} | Failed: ${failed.length}${skipped.length > 0 ? ` | Skipped: ${skipped.length}` : ''}`,
    ];

    if (failed.length > 0) {
      summary.push('', '**Failures:**');
      for (const f of failed.slice(0, 10)) {
        summary.push(f.slice(0, 500));
      }
      if (failed.length > 10) {
        summary.push(`\n... and ${failed.length - 10} more failures`);
      }
    }

    // If we couldn't parse anything, surface the raw output with an explicit
    // annotation so the model doesn't pretend it has structured pass/fail counts.
    if (total === 0) {
      return `[parsed: no — ${parser} output did not match known patterns; showing raw output. Treat any pass/fail claims from this with skepticism.]\n\n${raw}`;
    }

    summary.unshift(`[parsed: yes — ${parser}]`);
    return summary.join('\n');
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
        // Smart push: auto-add --set-upstream for new branches, parse auth errors.
        return this.smartGitPush(typeof input.args === 'string' ? input.args.trim() : '');
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
   * git_push wrapper that (a) auto-sets upstream on first push of a new branch,
   * and (b) translates common remote-side errors into actionable messages for
   * the model so it doesn't waste iterations retrying blindly.
   */
  private async smartGitPush(userArgs: string): Promise<string> {
    // If the user supplied explicit args (remote/branch/flags), respect them verbatim.
    // We only auto-upstream when no args were given.
    let finalArgs = userArgs;
    let autoUpstreamBranch: string | null = null;
    if (!userArgs) {
      // Detect current branch
      const branchOut = await this.execGitCommand('rev-parse --abbrev-ref HEAD');
      const currentBranch = extractGitValue(branchOut);
      if (!currentBranch || currentBranch === 'HEAD') {
        return `Error: Could not determine current branch (detached HEAD?). Use git_checkout to switch to a branch first.\n${branchOut}`;
      }

      // Check if the branch has an upstream
      const upstreamOut = await this.execGitCommand('rev-parse --abbrev-ref --symbolic-full-name @{u}');
      const hasUpstream = !/fatal:|error:|no upstream/i.test(upstreamOut) && !!extractGitValue(upstreamOut);

      if (!hasUpstream) {
        finalArgs = `--set-upstream origin ${currentBranch}`;
        autoUpstreamBranch = currentBranch;
      }
    }

    const raw = await this.execGitCommand(`push${finalArgs ? ' ' + finalArgs : ''}`);
    return annotatePushResult(raw, autoUpstreamBranch);
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
    const { name: gitName, email: gitEmail } = await resolveGitIdentity();
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
 * - Always configures git identity from GITHUB_TOKEN (or fallback)
 * - Uses GIT_ASKPASS for auth (never embeds token in URLs)
 *
 * Called at session startup so the model always sees a valid git repo.
 */
export async function ensureGitWorkspace(
  sandboxDir: string,
  repoUrl: string,
): Promise<{ ok: boolean; message: string }> {
  // Resolve git identity upfront so it's available for all operations
  const identity = await resolveGitIdentity();

  // Build a secure credential environment (GIT_ASKPASS, never token-in-URL)
  const { env: credEnv, cleanup } = await buildGitCredentialEnv();

  const execGit = (args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number | null }> => {
    return new Promise((resolve) => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: sandboxDir,
        GIT_AUTHOR_NAME: identity.name,
        GIT_COMMITTER_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_EMAIL: identity.email,
        ...credEnv,
      };
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
      // Already cloned — configure identity + pull latest
      logger.info({ sandboxDir, repoUrl }, 'Workspace already has git repo, configuring identity and pulling latest');

      // Set identity in repo config so it persists for all future commands
      await execGit(['config', 'user.name', identity.name], 5000);
      await execGit(['config', 'user.email', identity.email], 5000);

      const result = await execGit(['pull', '--ff-only'], 30_000);
      await cleanup();
      if (result.code === 0) {
        return { ok: true, message: `Pulled latest changes (identity: ${identity.name} <${identity.email}>)` };
      }
      // Pull failed (diverged, etc.) — still usable, just warn
      logger.warn({ stderr: result.stderr, sandboxDir }, 'Git pull failed, workspace may be stale');
      return { ok: true, message: 'Workspace has existing repo (pull failed, using as-is)' };
    }

    if (files.length > 0) {
      // Directory has files but no .git — can't clone into it
      await cleanup();
      logger.warn({ sandboxDir, fileCount: files.length }, 'Workspace has files but is not a git repo');
      return { ok: false, message: 'Workspace has existing files but is not a git repo' };
    }

    // Empty directory — clone using GIT_ASKPASS (no token in URL)
    logger.info({ repoUrl, sandboxDir }, 'Cloning repo into workspace');
    const result = await execGit(['clone', '--depth', '1', repoUrl, '.']);
    if (result.code === 0) {
      // Configure identity on the freshly cloned repo
      await execGit(['config', 'user.name', identity.name], 5000);
      await execGit(['config', 'user.email', identity.email], 5000);
      await cleanup();
      return { ok: true, message: `Repository cloned (identity: ${identity.name} <${identity.email}>)` };
    }

    await cleanup();
    logger.warn({ stderr: result.stderr, code: result.code, repoUrl }, 'Git clone failed');
    return { ok: false, message: `Clone failed: ${result.stderr.slice(0, 200)}` };
  } catch (err) {
    await cleanup();
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sandboxDir, repoUrl }, 'ensureGitWorkspace failed');
    return { ok: false, message: `Workspace setup error: ${msg}` };
  }
}

/**
 * Run ripgrep (preferred) or grep over a cloned workspace. Substring-literal by default.
 * Returns a formatted result with up to `maxResults` hits across up to `maxFiles` files.
 * This is the real grep that `search_code` should prefer over GitHub's token-indexed API.
 */
export async function grepWorkspace(
  sandboxDir: string,
  query: string,
  opts: { isRegex?: boolean; maxResults?: number; maxFiles?: number } = {},
): Promise<{ ok: boolean; output: string }> {
  const maxResults = opts.maxResults ?? 30;
  const maxFiles = opts.maxFiles ?? 15;

  // Prefer ripgrep when available — faster, gitignore-aware, clean output
  const rgArgs = [
    '--no-heading',
    '--line-number',
    '--color', 'never',
    '--max-count', '5',          // per file
    '--max-columns', '240',
    '-I',                         // skip binaries
    ...(opts.isRegex ? [] : ['--fixed-strings']),
    '--', query,
  ];

  const run = (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> => {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        cwd: sandboxDir,
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ stdout, stderr, code }));
      proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }));
    });
  };

  let result = await run('rg', rgArgs);
  // rg exits 1 when no match, 2 on error. 127 means rg not installed.
  if (result.code === 127 || /command not found|ENOENT/i.test(result.stderr)) {
    const grepArgs = [
      '-rnI',
      '--max-count=5',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      opts.isRegex ? '-E' : '-F',
      '--', query, '.',
    ];
    result = await run('grep', grepArgs);
  }

  if (result.code === 1 || (result.code === 0 && !result.stdout.trim())) {
    return { ok: true, output: `No matches for \`${query}\` in the cloned workspace.` };
  }
  if (result.code !== 0 && result.code !== 1) {
    return { ok: false, output: `Search failed: ${result.stderr.slice(0, 300) || 'exit ' + result.code}` };
  }

  // Parse "path:line:content" and group by file
  const lines = result.stdout.split('\n').filter(Boolean);
  const byFile = new Map<string, string[]>();
  for (const line of lines) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, path, ln, snippet] = m;
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path)!.push(`  L${ln}: ${snippet.trim().slice(0, 200)}`);
  }

  const files = Array.from(byFile.entries()).slice(0, maxFiles);
  let hitCount = 0;
  const chunks: string[] = [];
  for (const [path, hits] of files) {
    const shown = hits.slice(0, Math.max(1, maxResults - hitCount));
    hitCount += shown.length;
    chunks.push(`${path}\n${shown.join('\n')}`);
    if (hitCount >= maxResults) break;
  }

  const extraFiles = byFile.size > files.length ? `\n\n[${byFile.size - files.length} more file(s) with matches not shown]` : '';
  return {
    ok: true,
    output: `Found ${hitCount} match(es) in ${Math.min(byFile.size, files.length)} file(s) for \`${query}\`:\n\n${chunks.join('\n\n')}${extraFiles}`,
  };
}

/**
 * Extract the single-line value from an `execGitCommand` output string.
 * The wrapper may add prefixes like `stdout:` / exit-code lines; pull the first
 * non-empty line that isn't an obvious label or error.
 */
function extractGitValue(output: string): string | null {
  if (!output) return null;
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^(stdout|stderr|exit code|error|fatal|\[|---)/i.test(t)) continue;
    return t;
  }
  return null;
}

/**
 * Annotate `git push` output with a human-friendly diagnosis when GitHub returns
 * a recognizable error. Prevents the model from retrying the same failing push.
 */
function annotatePushResult(raw: string, autoUpstreamBranch: string | null): string {
  const lower = raw.toLowerCase();
  const prefix = autoUpstreamBranch
    ? `[auto: added --set-upstream origin ${autoUpstreamBranch} because branch had no upstream]\n\n`
    : '';

  // Auth / token issues
  if (
    lower.includes('could not read username') ||
    lower.includes('authentication failed') ||
    lower.includes('invalid username or token') ||
    lower.includes('403 forbidden') ||
    lower.includes('permission to') && lower.includes('denied')
  ) {
    return (
      prefix +
      `Push failed: authentication/permission error.\n\n` +
      `Likely causes: (1) GITHUB_TOKEN is missing or lacks write access to this repo; ` +
      `(2) the token is scoped to the wrong org/user; (3) branch protection requires a review. ` +
      `Do NOT retry this push until the root cause is addressed. Ask the user (or an admin) to refresh the token.\n\n` +
      `--- raw output ---\n${raw}`
    );
  }

  // Non-fast-forward / diverged
  if (lower.includes('non-fast-forward') || lower.includes('updates were rejected') || lower.includes('failed to push some refs')) {
    return (
      prefix +
      `Push rejected: remote has commits your local branch doesn't have. ` +
      `Run git_pull (or git_pull "--rebase") first to integrate remote changes, then push again. ` +
      `Do NOT force-push unless the user explicitly authorizes it.\n\n` +
      `--- raw output ---\n${raw}`
    );
  }

  // Branch protection
  if (lower.includes('protected branch') || lower.includes('gh006') || lower.includes('required status check')) {
    return (
      prefix +
      `Push rejected: the target branch is protected and requires a PR with reviews/status checks. ` +
      `Push to a feature branch and open a PR with create_pr.\n\n` +
      `--- raw output ---\n${raw}`
    );
  }

  // Success path — keep raw output but prepend the auto-upstream note
  return prefix + raw;
}

/**
 * Resolve git identity from GITHUB_TOKEN.
 * Calls GET /user once and caches for the process lifetime.
 */
async function resolveGitIdentity(): Promise<{ name: string; email: string }> {
  if (cachedGitHubUser) return cachedGitHubUser;

  if (config.GITHUB_TOKEN) {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${config.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const user = await res.json() as { login: string; name: string | null; id: number };
        cachedGitHubUser = {
          name: user.name || user.login,
          email: `${user.id}+${user.login}@users.noreply.github.com`,
        };
        logger.info(`Git identity resolved from GitHub token: ${cachedGitHubUser.name} <${cachedGitHubUser.email}>`);
        return cachedGitHubUser;
      }
    } catch {
      // Network error — fall through to default
    }
  }

  return { name: 'AI Assistant', email: 'noreply@users.noreply.github.com' };
}

/**
 * Build GIT_ASKPASS environment for secure credential passing.
 * Creates a temporary script that provides the token without embedding it in URLs.
 */
async function buildGitCredentialEnv(): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  if (!config.GITHUB_TOKEN) return { env: { GIT_TERMINAL_PROMPT: '0' }, cleanup: async () => {} };

  try {
    const askpassPath = join(tmpdir(), `.git-askpass-${Date.now()}-${process.pid}.sh`);
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
    return { env: { GIT_TERMINAL_PROMPT: '0' }, cleanup: async () => {} };
  }
}
