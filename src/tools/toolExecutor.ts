import { RepoFetcher } from '../github/repoFetcher.js';
import { executeScript, sandboxWriteFile, sandboxReadFile, sandboxListFiles, getSandboxDir } from './scriptExecutor.js';
import { DevToolExecutor, GIT_TOOL_NAMES, WORKSPACE_TOOL_NAMES, ADVANCED_TOOL_NAMES, ensureGitWorkspace } from './devToolExecutor.js';
import { webSearch, webFetch } from './webSearchExecutor.js';
import { editFile } from './fileEditor.js';
import { findDefinitions, findReferences, analyzeImports, findCallers, affectedFiles } from './codeAnalyzer.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const MAX_FILE_CONTENT = 50_000; // 50KB truncation for tool results
const MAX_PATH_LENGTH = 500;
const MAX_QUERY_LENGTH = 200;
const MAX_SCRIPT_LENGTH = 50_000;

const DEV_TOOL_NAMES = new Set(['run_terminal', 'build_project', ...GIT_TOOL_NAMES, ...WORKSPACE_TOOL_NAMES, ...ADVANCED_TOOL_NAMES]);
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch']);
const INTERACTIVE_TOOL_NAMES = new Set(['request_input']);
const GITHUB_TOOL_NAMES = new Set(['create_pr', 'read_github_issue', 'create_github_issue']);

/** Special result type for request_input - signals the agent loop to pause */
export const REQUEST_INPUT_RESULT = Symbol('REQUEST_INPUT');

export interface RequestInputPayload {
  question: string;
  options?: string[];
  allowFreeText: boolean;
}

export class ToolExecutor {
  private sandboxDir: string | null = null;
  private devExecutor: DevToolExecutor | null = null;
  /** Cached repo tree to avoid re-fetching on every search_files call within one agent loop */
  private treeCache: string[] | null = null;
  private gitWorkspaceReady = false;

  constructor(
    private repoFetcher: RepoFetcher | null,
    private owner: string,
    private repo: string,
    private sessionId?: string,
    private repoUrl?: string,
    private defaultBranch?: string,
  ) {}

  /**
   * Get or lazily create the sandbox directory for this session.
   * If a repo URL is attached and dev tools are enabled, ensures the
   * workspace is a valid git repo (clone if new, pull if existing).
   */
  private async getSandbox(): Promise<string> {
    if (!this.sandboxDir) {
      this.sandboxDir = await getSandboxDir(this.sessionId);
    }
    // Ensure git workspace is set up on first access when we have a repo
    if (!this.gitWorkspaceReady && this.repoUrl && config.ENABLE_DEV_TOOLS) {
      this.gitWorkspaceReady = true;
      const result = await ensureGitWorkspace(this.sandboxDir, this.repoUrl);
      logger.info({ repoUrl: this.repoUrl, sandboxDir: this.sandboxDir, ...result }, 'Git workspace setup for agent');
    }
    return this.sandboxDir;
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string | typeof REQUEST_INPUT_RESULT> {
    const startTime = Date.now();
    try {
      if (!input || typeof input !== 'object') {
        return 'Error: Invalid tool input';
      }

      // Route interactive tools (special handling in agent loop)
      if (INTERACTIVE_TOOL_NAMES.has(toolName)) {
        // The request_input tool is handled specially by returning a symbol
        // The agent loop will pause and wait for user input
        // But the actual execute call returns a string result, so we return
        // the result directly from agent loop. Here we just validate params.
        return this.handleRequestInput(input);
      }

      // Route dev tools to DevToolExecutor
      if (DEV_TOOL_NAMES.has(toolName)) {
        if (!(config as any).ENABLE_DEV_TOOLS) {
          return 'Error: Dev tools are disabled. An admin can enable them with `/config set ENABLE_DEV_TOOLS true`.';
        }
        if (!this.devExecutor) {
          const sandbox = await this.getSandbox();
          this.devExecutor = new DevToolExecutor(sandbox);
        }
        const result = await this.devExecutor.execute(toolName, input);
        const duration = Date.now() - startTime;
        logger.debug({ toolName, duration }, 'Dev tool executed');
        return result;
      }

      // Route web tools
      if (WEB_TOOL_NAMES.has(toolName)) {
        if (!config.ENABLE_WEB_SEARCH) {
          return 'Error: Web search is disabled. An admin can enable it with `/config set ENABLE_WEB_SEARCH true`.';
        }
        let result: string;
        if (toolName === 'web_search') {
          const query = input.query;
          if (typeof query !== 'string' || query.length === 0) return 'Error: query must be a non-empty string';
          result = await webSearch(query);
        } else {
          const url = input.url;
          if (typeof url !== 'string' || url.length === 0) return 'Error: url must be a non-empty string';
          result = await webFetch(url);
        }
        const duration = Date.now() - startTime;
        logger.debug({ toolName, duration }, 'Web tool executed');
        return result;
      }

      // Route GitHub tools (create_pr, read_github_issue, create_github_issue)
      if (GITHUB_TOOL_NAMES.has(toolName)) {
        if (!config.GITHUB_TOKEN) {
          return 'Error: GITHUB_TOKEN is required for GitHub tools. An admin can set it with `/admin setgittoken`.';
        }
        if (!config.ENABLE_DEV_TOOLS) {
          return 'Error: GitHub tools require dev tools to be enabled. An admin can enable them with `/config set ENABLE_DEV_TOOLS true`.';
        }
        const result = await this.executeGithubTool(toolName, input);
        const duration = Date.now() - startTime;
        logger.debug({ toolName, duration }, 'GitHub tool executed');
        return result;
      }

      let result: string;
      switch (toolName) {
        case 'analyze_code': {
          if (!this.repoFetcher) return 'Error: No repository attached. Use /repo to attach one.';
          result = await this.analyzeCode(input);
          break;
        }
        case 'read_file': {
          if (!this.repoFetcher) return 'Error: No repository attached. Use /repo to attach one.';
          const path = input.path;
          if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
            return 'Error: path must be a non-empty string (max 500 chars)';
          }
          result = await this.readFile(path);
          break;
        }
        case 'list_directory': {
          if (!this.repoFetcher) return 'Error: No repository attached. Use /repo to attach one.';
          const path = input.path;
          if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH) {
            return 'Error: path must be a string (max 500 chars)';
          }
          result = await this.listDirectory(path);
          break;
        }
        case 'search_code': {
          if (!this.repoFetcher) return 'Error: No repository attached. Use /repo to attach one.';
          const query = input.query;
          if (typeof query !== 'string' || query.length === 0 || query.length > MAX_QUERY_LENGTH) {
            return 'Error: query must be a non-empty string (max 200 chars)';
          }
          result = await this.searchCode(query);
          break;
        }
        case 'search_files': {
          if (!this.repoFetcher) return 'Error: No repository attached. Use /repo to attach one.';
          const pattern = input.pattern;
          if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_QUERY_LENGTH) {
            return 'Error: pattern must be a non-empty string (max 200 chars)';
          }
          result = await this.searchFiles(pattern);
          break;
        }
        case 'read_files_batch': {
          if (!this.repoFetcher) return 'Error: No repository attached. Use /repo to attach one.';
          const paths = input.paths;
          if (typeof paths !== 'string' || paths.length === 0) {
            return 'Error: paths must be a non-empty comma-separated string';
          }
          const pathList = paths.split(',').map((p) => p.trim()).filter(Boolean).slice(0, 10);
          if (pathList.length === 0) return 'Error: no valid paths provided';
          result = await this.readFilesBatch(pathList);
          break;
        }
        case 'run_script': {
          const language = input.language;
          const code = input.code;
          if (typeof language !== 'string' || language.length === 0) {
            return 'Error: language must be a non-empty string';
          }
          if (typeof code !== 'string' || code.length === 0 || code.length > MAX_SCRIPT_LENGTH) {
            return 'Error: code must be a non-empty string (max 50KB)';
          }
          const sandbox = await this.getSandbox();
          result = await executeScript(language, code, sandbox);
          break;
        }
        case 'write_file': {
          const path = input.path;
          const content = input.content;
          if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
            return 'Error: path must be a non-empty string (max 500 chars)';
          }
          if (typeof content !== 'string' || content.length > MAX_SCRIPT_LENGTH) {
            return 'Error: content must be a string (max 50KB)';
          }
          const sandbox = await this.getSandbox();
          result = await sandboxWriteFile(path, content, sandbox);
          break;
        }
        case 'edit_file': {
          if (!(config as any).ENABLE_SCRIPT_EXECUTION) {
            return 'Error: edit_file requires script execution to be enabled. An admin can enable it with `/config set ENABLE_SCRIPT_EXECUTION true`.';
          }
          const path = input.path;
          const edits = input.edits;
          if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
            return 'Error: path must be a non-empty string (max 500 chars)';
          }
          if (typeof edits !== 'string' || edits.length === 0) {
            return 'Error: edits must be a JSON array string';
          }
          const sandbox = await this.getSandbox();
          const editResult = await editFile(path, edits, sandbox);
          result = editResult.message;
          break;
        }
        case 'read_local_file': {
          const path = input.path;
          if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
            return 'Error: path must be a non-empty string (max 500 chars)';
          }
          const sandbox = await this.getSandbox();
          result = await sandboxReadFile(path, sandbox);
          break;
        }
        case 'list_workspace': {
          const path = input.path;
          if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH) {
            return 'Error: path must be a string (max 500 chars)';
          }
          const sandbox = await this.getSandbox();
          result = await sandboxListFiles(path, sandbox);
          break;
        }
        default:
          result = `Unknown tool: ${toolName}`;
      }

      const duration = Date.now() - startTime;
      logger.debug({ toolName, duration }, 'Tool executed');
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      logger.warn({ err, toolName, input, duration, owner: this.owner, repo: this.repo }, 'Tool execution failed');
      return `Error: ${message}`;
    }
  }

  /**
   * Handle request_input tool - validates parameters and returns special signal.
   * The actual user interaction happens in agentLoop.ts which has access to Discord.
   */
  private handleRequestInput(input: Record<string, unknown>): typeof REQUEST_INPUT_RESULT {
    // This is a special tool - the agent loop intercepts it before calling execute()
    // So this code path shouldn't normally be reached.
    // But we have it here for completeness and validation.
    return REQUEST_INPUT_RESULT;
  }

  private async executeGithubTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    if (!this.repoFetcher) {
      return 'Error: No repository attached. Use /repo to attach one.';
    }

    switch (toolName) {
      case 'create_pr': {
        // Determine current branch from workspace
        const sandbox = await this.getSandbox();
        const { execSync } = await import('node:child_process');
        let head: string;
        try {
          head = execSync('git rev-parse --abbrev-ref HEAD', { cwd: sandbox, encoding: 'utf-8', timeout: 5000 }).trim();
        } catch {
          return 'Error: Could not determine current branch. Make sure you are in a git repository with commits.';
        }

        const base = (typeof input.base === 'string' && input.base) ? input.base : (this.defaultBranch || 'main');
        const title = (typeof input.title === 'string' && input.title) ? input.title : head.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const body = typeof input.body === 'string' ? input.body : '';
        const draft = input.draft === true;

        if (head === base) {
          return `Error: Current branch "${head}" is the same as base "${base}". Create a feature branch, commit changes, and push before creating a PR.`;
        }

        try {
          const result = await this.repoFetcher.createPR(this.owner, this.repo, head, base, title, body, draft);
          return `PR created successfully!\n**PR #${result.number}:** ${title}\n**URL:** ${result.url}`;
        } catch (err: any) {
          const msg = err.message || String(err);
          if (msg.includes('already exists')) {
            return `Error: A pull request already exists for branch "${head}" → "${base}". ${msg}`;
          }
          return `Error creating PR: ${msg}`;
        }
      }

      case 'read_github_issue': {
        const issueRef = input.issue;
        if (typeof issueRef !== 'string' || issueRef.length === 0) {
          return 'Error: issue must be a non-empty string (number, URL, or owner/repo#N)';
        }

        const parsed = this.parseIssueRef(issueRef);
        if (!parsed) {
          return 'Error: Invalid issue format. Use a number (42), URL (https://github.com/owner/repo/issues/42), or owner/repo#42.';
        }

        try {
          return await this.repoFetcher.readIssue(parsed.owner, parsed.repo, parsed.number);
        } catch (err: any) {
          return `Error reading issue: ${err.message || String(err)}`;
        }
      }

      case 'create_github_issue': {
        const title = input.title;
        if (typeof title !== 'string' || title.length === 0) {
          return 'Error: title must be a non-empty string';
        }
        const body = typeof input.body === 'string' ? input.body : undefined;
        const labels = typeof input.labels === 'string'
          ? input.labels.split(',').map((l: string) => l.trim()).filter(Boolean)
          : undefined;

        try {
          const result = await this.repoFetcher.createIssue(this.owner, this.repo, title, body, labels);
          return `Issue created successfully!\n**Issue #${result.number}:** ${title}\n**URL:** ${result.url}`;
        } catch (err: any) {
          return `Error creating issue: ${err.message || String(err)}`;
        }
      }

      default:
        return `Unknown GitHub tool: ${toolName}`;
    }
  }

  private parseIssueRef(ref: string): { owner: string; repo: string; number: number } | null {
    // Number only: use session repo
    const numMatch = ref.match(/^(\d+)$/);
    if (numMatch) {
      return { owner: this.owner, repo: this.repo, number: parseInt(numMatch[1], 10) };
    }

    // URL: https://github.com/owner/repo/issues/42
    const urlMatch = ref.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (urlMatch) {
      return { owner: urlMatch[1], repo: urlMatch[2], number: parseInt(urlMatch[3], 10) };
    }

    // Short: owner/repo#42
    const shortMatch = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (shortMatch) {
      return { owner: shortMatch[1], repo: shortMatch[2], number: parseInt(shortMatch[3], 10) };
    }

    return null;
  }

  private async analyzeCode(input: Record<string, unknown>): Promise<string> {
    const analysisType = input.analysis_type;
    const symbol = typeof input.symbol === 'string' ? input.symbol : '';
    const file = typeof input.file === 'string' ? input.file : '';
    const includeTests = input.include_tests === true;

    if (!['definitions', 'references', 'imports', 'callers', 'affected'].includes(analysisType as string)) {
      return 'Error: analysis_type must be one of: definitions, references, imports, callers, affected';
    }

    switch (analysisType) {
      case 'definitions': {
        if (!symbol) return 'Error: symbol parameter is required for definitions analysis';
        return findDefinitions(this.repoFetcher!, this.owner, this.repo, symbol, includeTests);
      }
      case 'references': {
        if (!symbol) return 'Error: symbol parameter is required for references analysis';
        return findReferences(this.repoFetcher!, this.owner, this.repo, symbol, includeTests);
      }
      case 'imports': {
        if (!file) return 'Error: file parameter is required for imports analysis';
        return analyzeImports(this.repoFetcher!, this.owner, this.repo, file);
      }
      case 'callers': {
        if (!symbol) return 'Error: symbol parameter is required for callers analysis';
        return findCallers(this.repoFetcher!, this.owner, this.repo, symbol, includeTests);
      }
      case 'affected': {
        if (!file) return 'Error: file parameter is required for affected analysis';
        return affectedFiles(this.repoFetcher!, this.owner, this.repo, file);
      }
      default:
        return `Error: Unknown analysis type: ${analysisType}`;
    }
  }

  private async readFile(path: string): Promise<string> {
    const files = await this.repoFetcher!.fetchFiles(this.owner, this.repo, [path]);
    if (files.length === 0) {
      return `File not found: ${path}`;
    }
    const content = files[0].content;
    if (content.length > MAX_FILE_CONTENT) {
      return content.slice(0, MAX_FILE_CONTENT) + `\n\n[Truncated — file is ${Math.round(content.length / 1000)}KB]`;
    }
    return content;
  }

  private async listDirectory(path: string): Promise<string> {
    const entries = await this.repoFetcher!.listDirectory(this.owner, this.repo, path);
    if (entries.length === 0) {
      return `Directory is empty or not found: ${path || '/'}`;
    }
    return entries.join('\n');
  }

  private async searchCode(query: string): Promise<string> {
    const results = await this.repoFetcher!.searchCode(this.owner, this.repo, query);
    if (results.length === 0) {
      return `No results found for: ${query}`;
    }
    return results
      .map((r: { path: string; snippet: string }, i: number) => `[${i + 1}] ${r.path}\n${r.snippet}`)
      .join('\n\n---\n\n');
  }

  private async searchFiles(pattern: string): Promise<string> {
    if (!this.treeCache) {
      this.treeCache = await this.repoFetcher!.getTree(this.owner, this.repo);
    }
    const allFiles = this.treeCache;
    const regex = globToRegex(pattern);
    const matches = allFiles.filter((p) => regex.test(p));
    if (matches.length === 0) {
      return `No files matched pattern: ${pattern}`;
    }
    const limited = matches.slice(0, 50);
    const suffix = matches.length > 50 ? `\n\n[${matches.length - 50} more results not shown]` : '';
    return `${limited.length} file(s) matching \`${pattern}\`:\n${limited.join('\n')}${suffix}`;
  }

  private async readFilesBatch(paths: string[]): Promise<string> {
    const files = await this.repoFetcher!.fetchFiles(this.owner, this.repo, paths);
    if (files.length === 0) {
      return 'No files found for the given paths.';
    }
    return files.map((f) => {
      const content = f.content.length > MAX_FILE_CONTENT
        ? f.content.slice(0, MAX_FILE_CONTENT) + `\n\n[Truncated — ${Math.round(f.content.length / 1000)}KB]`
        : f.content;
      return `=== ${f.path} ===\n${content}`;
    }).join('\n\n');
  }
}

/**
 * Convert a glob pattern to a RegExp for matching file paths.
 * Supports: * (within segment), ** (across segments), ? (single char).
 */
function globToRegex(pattern: string): RegExp {
  let r = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      r += '.*';
      i += 2;
      if (pattern[i] === '/') i++; // skip optional trailing slash after **
    } else if (c === '*') {
      r += '[^/]*';
      i++;
    } else if (c === '?') {
      r += '[^/]';
      i++;
    } else {
      // Escape regex special chars
      r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${r}$`, 'i');
}