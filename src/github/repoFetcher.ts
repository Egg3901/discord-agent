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
      request: {
        timeout: 15_000, // 15 second timeout per request
      },
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
   * List repositories accessible to the authenticated user.
   * Returns repo full names (owner/repo) for use in autocomplete.
   * Requires GITHUB_TOKEN to be configured.
   */
  async listUserRepos(query?: string): Promise<{ fullName: string; description: string | null; isPrivate: boolean }[]> {
    if (!config.GITHUB_TOKEN) return [];

    try {
      const { data } = await this.octokit.repos.listForAuthenticatedUser({
        sort: 'updated',
        per_page: 25,
        type: 'all',
      });

      let repos = data.map((r) => ({
        fullName: r.full_name,
        description: r.description,
        isPrivate: r.private,
      }));

      // Filter by query if provided
      if (query) {
        const q = query.toLowerCase();
        repos = repos.filter((r) => r.fullName.toLowerCase().includes(q));
      }

      return repos.slice(0, 25); // Discord autocomplete limit
    } catch (err) {
      logger.warn({ err }, 'Failed to list user repos');
      return [];
    }
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

  /**
   * List entries (files and directories) at a single directory level.
   */
  async listDirectory(
    owner: string,
    repo: string,
    path: string,
  ): Promise<string[]> {
    const { data } = await this.octokit.repos.getContent({
      owner,
      repo,
      path: path || '',
    });

    if (!Array.isArray(data)) {
      return [`[file] ${(data as any).name}`];
    }

    return (data as any[]).map(
      (entry: { name: string; type: string }) =>
        `${entry.type === 'dir' ? '[dir]  ' : '[file] '}${entry.name}`,
    );
  }

  /**
   * Search for code in a repository using the GitHub code search API.
   * Returns up to 10 matching file paths with line snippets.
   */
  async searchCode(
    owner: string,
    repo: string,
    query: string,
  ): Promise<{ path: string; snippet: string }[]> {
    const { data } = await this.octokit.search.code({
      q: `${query} repo:${owner}/${repo}`,
      per_page: 10,
      headers: {
        accept: 'application/vnd.github.text-match+json',
      },
    });

    return data.items.map((item: any) => ({
      path: item.path,
      snippet: item.text_matches?.[0]?.fragment || '(no preview)',
    }));
  }

  /**
   * Fetch a pull request's metadata and diff for code review.
   * Returns a formatted string with PR details, description, and file diffs (truncated).
   */
  async fetchPR(owner: string, repo: string, prNumber: number): Promise<string> {
    const MAX_DIFF_SIZE = 40_000; // 40KB diff limit for context window

    // Fetch PR metadata
    const { data: pr } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });

    // Fetch changed files list
    const { data: files } = await this.octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 50,
    });

    const sections: string[] = [];

    sections.push(`## PR #${prNumber}: ${pr.title}`);
    sections.push(`**State:** ${pr.state} | **Author:** ${pr.user?.login} | **Branch:** \`${pr.head.ref}\` → \`${pr.base.ref}\``);
    sections.push(`**URL:** ${pr.html_url}`);

    if (pr.body?.trim()) {
      sections.push(`\n### Description\n${pr.body.trim()}`);
    }

    sections.push(`\n### Changed Files (${files.length})`);
    const fileSummary = files.map((f) =>
      `- \`${f.filename}\` (+${f.additions} -${f.deletions}) [${f.status}]`,
    ).join('\n');
    sections.push(fileSummary);

    // Append diffs (truncated)
    let totalDiffSize = 0;
    const diffSections: string[] = [];
    for (const file of files) {
      if (!file.patch) continue;
      const patch = file.patch;
      totalDiffSize += patch.length;
      if (totalDiffSize > MAX_DIFF_SIZE) {
        diffSections.push(`\n### ${file.filename}\n[Diff omitted — total diff too large]`);
        break;
      }
      diffSections.push(`\n### ${file.filename}\n\`\`\`diff\n${patch}\n\`\`\``);
    }

    if (diffSections.length > 0) {
      sections.push('\n### Diffs', ...diffSections);
    }

    return sections.join('\n');
  }
}
