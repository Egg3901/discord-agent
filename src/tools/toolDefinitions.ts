/**
 * Tool definitions for the agentic coding assistant.
 * Canonical format follows Anthropic's tool schema; adapters convert for other providers.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read the contents of a file from the GitHub repository attached to this session. Returns the full file content (truncated at 50KB).',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the repository root (e.g. "src/index.ts")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List files and subdirectories at a given path in the GitHub repository. Returns names with type indicators (file or directory).',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory path relative to the repository root. Use empty string "" for the root directory.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description:
      'Search for a text pattern across all files in the GitHub repository. Returns matching file paths and line snippets (up to 10 results).',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string (plain text, not regex)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_files',
    description:
      'Find files in the GitHub repository by name or glob pattern. Returns matching file paths. Supports wildcards: * (any chars within a path segment), ** (any chars across segments), ? (single char). Examples: "*.ts", "src/**/*.json", "*config*". Use this instead of recursive list_directory when you know the filename pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match against file paths (e.g. "*.ts", "src/**/*.json", "*config*")',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_files_batch',
    description:
      'Read multiple files from the GitHub repository in a single call. More efficient than multiple read_file calls. Returns each file\'s content separated by headers. Truncates each file at 50KB.',
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'string',
          description: 'Comma-separated list of file paths relative to the repo root (e.g. "src/index.ts,src/config.ts,README.md")',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'analyze_code',
    description:
      'Analyze code structure: find symbol definitions, locate all references, trace imports/exports, find callers of a function, or identify files affected by changes. More precise than text search for understanding code relationships.',
    input_schema: {
      type: 'object',
      properties: {
        analysis_type: {
          type: 'string',
          description: 'Type of analysis: "definitions" (find where symbol is defined), "references" (find all usages), "imports" (what a file imports), "callers" (what calls this function), "affected" (what files would be impacted by changes to a file)',
        },
        symbol: {
          type: 'string',
          description: 'Symbol name to analyze (function, class, variable, type) - used for definitions, references, and callers',
        },
        file: {
          type: 'string',
          description: 'File path to analyze - used for imports and affected analysis',
        },
        include_tests: {
          type: 'boolean',
          description: 'Include test files in results (default: false)',
        },
      },
      required: ['analysis_type'],
    },
  },
];

/**
 * Tools for sandboxed code execution and file I/O.
 * These are available when ENABLE_SCRIPT_EXECUTION is true, regardless of repo attachment.
 */
export const SANDBOX_TOOLS: ToolDefinition[] = [
  {
    name: 'run_script',
    description:
      'Execute a script in a sandboxed environment and return the output. Supported languages: python, javascript, typescript, bash, sh, ruby, perl. Use this to run code snippets, verify solutions, perform calculations, or demonstrate behavior. Scripts run in a persistent workspace where files from write_file are available.',
    input_schema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          description:
            'Programming language (python, javascript, typescript, bash, sh, ruby, perl)',
        },
        code: {
          type: 'string',
          description: 'The script code to execute',
        },
      },
      required: ['language', 'code'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write a file to the sandboxed workspace. Use this to create source files, config files, data files, or any other files needed for script execution. Files persist across tool calls within the same session.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the workspace root (e.g. "src/main.py", "data.json"). Subdirectories are created automatically.',
        },
        content: {
          type: 'string',
          description: 'The file content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Apply surgical edits to an existing file using SEARCH/REPLACE blocks. More efficient than rewriting entire files for targeted changes. Returns a unified diff preview showing what changed. Use this for single-line or multi-line edits to existing files.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the workspace root',
        },
        edits: {
          type: 'string',
          description: 'JSON array of edit operations. Each edit is {"oldText": "...", "newText": "..."}. newText can be empty for deletion. All edits apply atomically.',
        },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'read_local_file',
    description:
      'Read a file from the sandboxed workspace. Use this to check file contents, read script output files, or verify written files.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the workspace root',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_workspace',
    description:
      'List files and directories in the sandboxed workspace. Use this to see what files exist in the current workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to the workspace root. Use empty string "" for the root.',
        },
      },
      required: ['path'],
    },
  },
];

/**
 * Developer tools for terminal, build, and git operations.
 * Available when ENABLE_DEV_TOOLS is true.
 */
export const DEV_TOOLS: ToolDefinition[] = [
  {
    name: 'run_terminal',
    description:
      'Execute a shell command in the workspace. Returns stdout, stderr, and exit code. Use for installing dependencies, running builds, linting, testing, or any CLI operation. Commands run in the session workspace directory. Timeout: 60s.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute (e.g. "npm install", "ls -la", "cat package.json")',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'build_project',
    description:
      'Detect the project type and run its build/test commands. Auto-detects package.json (npm/yarn/pnpm), Makefile, Cargo.toml, pyproject.toml, etc. Pass a custom command to override auto-detection. Returns build output and success/failure status.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to run: "build", "test", "lint", "typecheck", or a custom command string. Defaults to "build".',
        },
      },
      required: [],
    },
  },
];

/**
 * Git tools — each operation is a separate tool so models clearly know what's available.
 * Available when ENABLE_DEV_TOOLS is true. These operate on the workspace directory,
 * which is automatically set up as a git repo when a GitHub repository is attached.
 */
export const GIT_TOOLS: ToolDefinition[] = [
  {
    name: 'git_status',
    description:
      'Show the working tree status. Returns which files are staged, modified, untracked, etc. Use this to check the current state before committing or to see what has changed.',
    input_schema: {
      type: 'object',
      properties: {
        flags: {
          type: 'string',
          description: 'Optional flags (e.g. "--short", "--porcelain"). Leave empty for default verbose output.',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_diff',
    description:
      'Show changes between commits, the working tree, and the staging area. By default shows unstaged changes. Use "--staged" to see what will be committed, or pass commit refs to compare.',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'What to diff (e.g. "--staged", "HEAD~1", "main..feature", "path/to/file"). Leave empty for unstaged changes.',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_log',
    description:
      'Show commit history. Returns commit hashes, authors, dates, and messages. Defaults to last 20 commits in oneline format.',
    input_schema: {
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Log arguments (e.g. "-10", "--oneline --graph", "--author=name", "main..HEAD", "--stat"). Defaults to "--oneline -20".',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_add',
    description:
      'Stage files for the next commit. Use "." to stage all changes, or specify individual file paths.',
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'string',
          description: 'Files to stage (e.g. ".", "src/index.ts", "src/a.ts src/b.ts"). Use "." for all changes.',
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'git_commit',
    description:
      'Create a new commit with the staged changes. Files must be staged first with git_add.',
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message (e.g. "fix: resolve null pointer in auth module")',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_push',
    description:
      'Push local commits to a remote repository. Requires GITHUB_TOKEN to be configured for authentication.',
    input_schema: {
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Push arguments (e.g. "origin main", "origin feature-branch", "--set-upstream origin new-branch"). Defaults to pushing the current branch.',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_pull',
    description:
      'Pull changes from a remote repository into the current branch.',
    input_schema: {
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Pull arguments (e.g. "origin main", "--rebase"). Defaults to pulling from the tracking branch.',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_branch',
    description:
      'List, create, or delete branches. With no arguments, lists local branches and shows the current one.',
    input_schema: {
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Branch arguments (e.g. "new-feature" to create, "-d old-branch" to delete, "-a" to list all including remote, "-m old new" to rename). Leave empty to list branches.',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_checkout',
    description:
      'Switch branches or restore working tree files. Use this to switch to an existing branch, create and switch to a new branch with "-b", or restore files.',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Branch name or file path (e.g. "main", "-b new-feature", "-- src/file.ts" to restore a file).',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'git_clone',
    description:
      'Clone a repository into the workspace. Only needed if the workspace was not automatically set up with a repo. Clones into the current directory.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Repository URL to clone (e.g. "https://github.com/owner/repo")',
        },
      },
      required: ['url'],
    },
  },
];

/**
 * Web search and fetch tools.
 * Available when ENABLE_WEB_SEARCH is true and BRAVE_SEARCH_API_KEY is set.
 */
export const WEB_TOOLS: ToolDefinition[] = [
  {
    name: 'web_search',
    description:
      'Search the web using Brave Search. Returns a list of results with titles, URLs, and descriptions. Use when you need current information, documentation, or facts that may not be in your training data.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g. "Next.js 15 release notes", "how to use Redis streams")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch the text content of a web page. Use after web_search to read a specific result in full. Returns extracted text content (HTML stripped), truncated to 50KB.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch (must start with http:// or https://)',
        },
      },
      required: ['url'],
    },
  },
];

/**
 * Interactive input tool for clarification prompts.
 * Available when ENABLE_SCRIPT_EXECUTION is true (sandbox tools enabled).
 */
export const INTERACTIVE_TOOLS: ToolDefinition[] = [
  {
    name: 'request_input',
    description:
      'Pause the agent and ask the user a clarifying question. Use when requirements are ambiguous, you need approval for destructive actions, or you need user input to proceed. The agent will wait for the user\'s response and resume with that response as the tool result.',
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user (max 1900 characters)',
        },
        options: {
          type: 'string',
          description: 'JSON array of predefined choice strings (e.g. \'["Option A", "Option B"]\'). If provided, shows as Discord buttons instead of free text.',
        },
        allow_free_text: {
          type: 'boolean',
          description: 'Allow free-form text response in addition to predefined options (default: true)',
        },
      },
      required: ['question'],
    },
  },
];

/**
 * Convert Anthropic-format tool definitions to OpenAI-compatible function format.
 * Used for Ollama and other OpenAI-compatible providers.
 */
export function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object' as const,
        properties: tool.input_schema.properties,
        required: tool.input_schema.required,
      },
    },
  }));
}

/**
 * Convert Anthropic-format tool definitions to Gemini FunctionDeclaration format.
 */
export function toGeminiFunctionDeclarations(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'OBJECT' as const,
      properties: Object.fromEntries(
        Object.entries(tool.input_schema.properties).map(([key, val]) => [
          key,
          { type: val.type.toUpperCase(), description: val.description },
        ]),
      ),
      required: tool.input_schema.required,
    },
  }));
}