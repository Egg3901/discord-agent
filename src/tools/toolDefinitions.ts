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
    name: 'git_command',
    description:
      'Run a git command in the workspace. Use for version control operations: status, diff, log, add, commit, branch, checkout, clone, pull, push. The workspace must be a git repo (or use git clone first). Returns command output.',
    input_schema: {
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Git subcommand and arguments (e.g. "status", "diff --staged", "log --oneline -10", "add .", "commit -m \\"fix: typo\\"")',
        },
      },
      required: ['args'],
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
