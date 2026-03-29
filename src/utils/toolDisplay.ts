/**
 * Shared tool display formatting for Discord messages.
 * Used by both /code command and messageCreate thread handler.
 */

/** Emoji per tool name */
export const TOOL_EMOJIS: Record<string, string> = {
  read_file: '\u{1F4C4}',
  list_directory: '\u{1F4C2}',
  search_code: '\u{1F50D}',
  search_files: '\u{1F50D}',
  read_files_batch: '\u{1F4C4}',
  run_script: '\u{25B6}\uFE0F',
  write_file: '\u{1F4DD}',
  read_local_file: '\u{1F4C4}',
  list_workspace: '\u{1F4C2}',
  run_terminal: '\u{1F4BB}',
  git_status: '\u{1F4CB}',
  git_diff: '\u{1F504}',
  git_log: '\u{1F4DC}',
  git_add: '\u{2795}',
  git_commit: '\u{2705}',
  git_push: '\u{2B06}\uFE0F',
  git_pull: '\u{2B07}\uFE0F',
  git_branch: '\u{1F500}',
  git_checkout: '\u{1F500}',
  git_clone: '\u{1F4E5}',
  build_project: '\u{1F3D7}\uFE0F',
  web_search: '\u{1F310}',
  web_fetch: '\u{1F310}',
};

/** Human-readable label per tool name */
export const TOOL_LABELS: Record<string, string> = {
  read_file: 'Reading',
  list_directory: 'Listing',
  search_code: 'Searching',
  search_files: 'Searching files',
  read_files_batch: 'Reading files',
  run_script: 'Running script',
  write_file: 'Writing',
  read_local_file: 'Reading',
  list_workspace: 'Listing workspace',
  run_terminal: 'Running',
  git_status: 'Git status',
  git_diff: 'Git diff',
  git_log: 'Git log',
  git_add: 'Git add',
  git_commit: 'Git commit',
  git_push: 'Git push',
  git_pull: 'Git pull',
  git_branch: 'Git branch',
  git_checkout: 'Git checkout',
  git_clone: 'Git clone',
  build_project: 'Building',
  web_search: 'Searching web',
  web_fetch: 'Fetching',
};

/**
 * Format a short detail string for an Anthropic/Gemini tool call notification.
 */
export function formatToolDetail(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
    case 'read_local_file':
    case 'write_file':
      return input.path ? `\`${String(input.path)}\`` : '';
    case 'list_directory':
    case 'list_workspace':
      return input.path ? `\`${String(input.path) || '/'}\`` : '`/`';
    case 'search_code':
      return input.query ? `for \`${String(input.query).slice(0, 60)}\`` : '';
    case 'search_files':
      return input.pattern ? `\`${String(input.pattern).slice(0, 60)}\`` : '';
    case 'read_files_batch':
      return input.paths ? `\`${String(input.paths).slice(0, 80)}\`` : '';
    case 'run_script':
      return input.language ? `(${String(input.language)})` : '';
    case 'run_terminal':
      return input.command ? `\`${String(input.command).slice(0, 80)}\`` : '';
    case 'git_status':
      return input.flags ? `\`${String(input.flags)}\`` : '';
    case 'git_diff':
      return input.target ? `\`${String(input.target).slice(0, 80)}\`` : '';
    case 'git_log':
      return input.args ? `\`${String(input.args).slice(0, 60)}\`` : '';
    case 'git_add':
      return input.files ? `\`${String(input.files).slice(0, 80)}\`` : '';
    case 'git_commit':
      return input.message ? `"${String(input.message).slice(0, 60)}"` : '';
    case 'git_push':
    case 'git_pull':
      return input.args ? `\`${String(input.args).slice(0, 60)}\`` : '';
    case 'git_branch':
      return input.args ? `\`${String(input.args).slice(0, 60)}\`` : '';
    case 'git_checkout':
      return input.target ? `\`${String(input.target).slice(0, 60)}\`` : '';
    case 'git_clone':
      return input.url ? `\`${String(input.url).slice(0, 80)}\`` : '';
    case 'build_project':
      return input.action ? `(${String(input.action)})` : '';
    case 'web_search':
      return input.query ? `\`${String(input.query).slice(0, 60)}\`` : '';
    case 'web_fetch':
      return input.url ? `\`${String(input.url).slice(0, 80)}\`` : '';
    default:
      return '';
  }
}

/**
 * Format a short detail string for a Claude Code internal tool call notification.
 * CC uses its own tool names (Bash, Read, Write, Glob, Grep, WebFetch, etc.)
 */
export function formatCCToolDetail(name: string, input: Record<string, unknown>): string {
  const n = name.toLowerCase();
  if (n === 'bash' || n === 'runterminal') {
    const cmd = input.command || input.cmd;
    return cmd ? `\`${String(cmd).slice(0, 80)}\`` : '';
  }
  if (n === 'read' || n === 'write' || n === 'edit' || n === 'multiedit') {
    const path = input.file_path || input.path;
    return path ? `\`${String(path)}\`` : '';
  }
  if (n === 'glob') return input.pattern ? `\`${String(input.pattern)}\`` : '';
  if (n === 'grep') {
    const p = input.pattern || input.query;
    return p ? `for \`${String(p).slice(0, 60)}\`` : '';
  }
  if (n === 'webfetch' || n === 'web_fetch') return input.url ? `\`${String(input.url).slice(0, 80)}\`` : '';
  if (n === 'websearch' || n === 'web_search') return input.query ? `\`${String(input.query).slice(0, 60)}\`` : '';
  // Generic fallback: show first key-value pair
  const first = Object.entries(input)[0];
  return first ? `${first[0]}: \`${String(first[1]).slice(0, 60)}\`` : '';
}
