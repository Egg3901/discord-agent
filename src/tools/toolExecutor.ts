import { RepoFetcher } from '../github/repoFetcher.js';
import { logger } from '../utils/logger.js';

const MAX_FILE_CONTENT = 50_000; // 50KB truncation for tool results
const MAX_PATH_LENGTH = 500;
const MAX_QUERY_LENGTH = 200;

export class ToolExecutor {
  constructor(
    private repoFetcher: RepoFetcher,
    private owner: string,
    private repo: string,
  ) {}

  async execute(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const startTime = Date.now();
    try {
      if (!input || typeof input !== 'object') {
        return 'Error: Invalid tool input';
      }

      let result: string;
      switch (toolName) {
        case 'read_file': {
          const path = input.path;
          if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
            return 'Error: path must be a non-empty string (max 500 chars)';
          }
          result = await this.readFile(path);
          break;
        }
        case 'list_directory': {
          const path = input.path;
          if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH) {
            return 'Error: path must be a string (max 500 chars)';
          }
          result = await this.listDirectory(path);
          break;
        }
        case 'search_code': {
          const query = input.query;
          if (typeof query !== 'string' || query.length === 0 || query.length > MAX_QUERY_LENGTH) {
            return 'Error: query must be a non-empty string (max 200 chars)';
          }
          result = await this.searchCode(query);
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
    const files = await this.repoFetcher.fetchFiles(this.owner, this.repo, [path]);
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
    const entries = await this.repoFetcher.listDirectory(this.owner, this.repo, path);
    if (entries.length === 0) {
      return `Directory is empty or not found: ${path || '/'}`;
    }
    return entries.join('\n');
  }

  private async searchCode(query: string): Promise<string> {
    const results = await this.repoFetcher.searchCode(this.owner, this.repo, query);
    if (results.length === 0) {
      return `No results found for: ${query}`;
    }
    return results
      .map((r, i) => `[${i + 1}] ${r.path}\n${r.snippet}`)
      .join('\n\n---\n\n');
  }
}
