import { Octokit } from '@octokit/rest';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface FetchedFile {
  path: string;
  content: string;
}

const MAX_FILE_SIZE = 100_000; // 100KB per file
const MAX_TOTAL_FILES = 20;

export class RepoFetcher {
  /**
   * Returns an Octokit instance using the current GITHUB_TOKEN from config.
   * Re-reads on every call so runtime token changes (via /admin or /config) take effect.
   */
  private get octokit(): Octokit {
    return new Octokit({
      auth: config.GITHUB_TOKEN || undefined,
    });
  }

  parseGitHubUrl(url: string): { owner: string; repo: string } {
    // Handle formats:
    // https://github.com/owner/repo
    // https://github.com/owner/repo.git
    // github.com/owner/repo
    const match = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (!match) {
      throw new Error(`Invalid GitHub URL: ${url}`);
    }
    return { owner: match[1], repo: match[2] };
  }

  /**
   * Fetch specific files from a repo, or auto-detect important files if no paths given.
   */
  async fetchFiles(
    owner: string,
    repo: string,
    paths?: string[],
  ): Promise<FetchedFile[]> {
    if (paths && paths.length > 0) {
      return this.fetchSpecificFiles(owner, repo, paths);
    }
    return this.fetchDefaultFiles(owner, repo);
  }

  /**
   * Fetch specific files by path.
   */
  private async fetchSpecificFiles(
    owner: string,
    repo: string,
    paths: string[],
  ): Promise<FetchedFile[]> {
    const files: FetchedFile[] = [];

    for (const path of paths.slice(0, MAX_TOTAL_FILES)) {
      try {
        const { data } = await this.octokit.repos.getContent({
          owner,
          repo,
          path,
        });

        if ('content' in data && data.type === 'file') {
          const content = Buffer.from(data.content, 'base64').toString('utf-8');
          if (content.length <= MAX_FILE_SIZE) {
            files.push({ path: data.path, content });
          }
        }
      } catch (err) {
        logger.warn({ path, owner, repo }, 'Failed to fetch file');
      }
    }

    return files;
  }

  /**
   * Auto-detect and fetch important files (README, package.json, main source files, etc.)
   */
  private async fetchDefaultFiles(
    owner: string,
    repo: string,
  ): Promise<FetchedFile[]> {
    const files: FetchedFile[] = [];

    // Get repo tree
    try {
      const { data: tree } = await this.octokit.git.getTree({
        owner,
        repo,
        tree_sha: 'HEAD',
        recursive: 'true',
      });

      // Priority files to fetch
      const priorityPatterns = [
        /^readme\.md$/i,
        /^package\.json$/,
        /^tsconfig\.json$/,
        /^cargo\.toml$/,
        /^pyproject\.toml$/,
        /^go\.mod$/,
        /^requirements\.txt$/,
        /^src\/index\.[jt]sx?$/,
        /^src\/main\.[jt]sx?$/,
        /^src\/app\.[jt]sx?$/,
        /^src\/lib\.[jt]sx?$/,
        /^main\.[jt]sx?$/,
        /^index\.[jt]sx?$/,
        /^app\.[jt]sx?$/,
      ];

      const filePaths: string[] = [];

      // First pass: priority files
      for (const item of tree.tree) {
        if (item.type !== 'blob' || !item.path) continue;
        for (const pattern of priorityPatterns) {
          if (pattern.test(item.path) && !filePaths.includes(item.path)) {
            filePaths.push(item.path);
            break;
          }
        }
      }

      // Second pass: other source files (up to limit)
      const sourceExtensions = /\.(ts|js|tsx|jsx|py|rs|go|java|rb|cpp|c|h)$/;
      for (const item of tree.tree) {
        if (filePaths.length >= MAX_TOTAL_FILES) break;
        if (item.type !== 'blob' || !item.path) continue;
        if (sourceExtensions.test(item.path) && !filePaths.includes(item.path)) {
          filePaths.push(item.path);
        }
      }

      // Fetch the files
      for (const path of filePaths) {
        try {
          const { data } = await this.octokit.repos.getContent({
            owner,
            repo,
            path,
          });

          if ('content' in data && data.type === 'file') {
            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            if (content.length <= MAX_FILE_SIZE) {
              files.push({ path: data.path, content });
            }
          }
        } catch {
          // Skip files that can't be fetched
        }
      }
    } catch (err) {
      logger.error({ err, owner, repo }, 'Failed to fetch repo tree');
      throw new Error('Could not access repository. Is it public or do you have a GITHUB_TOKEN configured?');
    }

    return files;
  }

  /**
   * Get the file tree of a repository.
   */
  async getTree(owner: string, repo: string): Promise<string[]> {
    const { data: tree } = await this.octokit.git.getTree({
      owner,
      repo,
      tree_sha: 'HEAD',
      recursive: 'true',
    });

    return tree.tree
      .filter((item) => item.type === 'blob' && item.path)
      .map((item) => item.path!);
  }
}
