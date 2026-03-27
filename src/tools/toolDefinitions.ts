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
