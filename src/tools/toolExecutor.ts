import { RepoFetcher } from '../github/repoFetcher.js';
import { logger } from '../utils/logger.js';

const MAX_FILE_CONTENT = 50_000; // 50KB truncation for tool results

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
    try {
      switch (toolName) {
        case 'read_file':
          return await this.readFile(input.path as string);
        case 'list_directory':
          return await this.listDirectory(input.path as string);
        case 'search_code':
          return await this.searchCode(input.query as string);
        default:
          return `Unknown tool: ${toolName}`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, toolName, input, owner: this.owner, repo: this.repo }, 'Tool execution failed');
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
    return results.map((r) => `${r.path}: ${r.snippet}`).join('\n');
  }
}
