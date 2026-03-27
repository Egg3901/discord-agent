import { RepoFetcher } from '../github/repoFetcher.js';
import { executeScript, sandboxWriteFile, sandboxReadFile, sandboxListFiles, getSandboxDir } from './scriptExecutor.js';
import { DevToolExecutor } from './devToolExecutor.js';
import { webSearch, webFetch } from './webSearchExecutor.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const MAX_FILE_CONTENT = 50_000; // 50KB truncation for tool results
const MAX_PATH_LENGTH = 500;
const MAX_QUERY_LENGTH = 200;
const MAX_SCRIPT_LENGTH = 50_000;

const DEV_TOOL_NAMES = new Set(['run_terminal', 'git_command', 'build_project']);
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch']);

export class ToolExecutor {
  private sandboxDir: string | null = null;
  private devExecutor: DevToolExecutor | null = null;

  constructor(
    private repoFetcher: RepoFetcher | null,
    private owner: string,
    private repo: string,
    private sessionId?: string,
  ) {}

  /**
   * Get or lazily create the sandbox directory for this session.
   */
  private async getSandbox(): Promise<string> {
    if (!this.sandboxDir) {
      this.sandboxDir = await getSandboxDir(this.sessionId);
    }
    return this.sandboxDir;
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const startTime = Date.now();
    try {
      if (!input || typeof input !== 'object') {
        return 'Error: Invalid tool input';
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

      let result: string;
      switch (toolName) {
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
}
