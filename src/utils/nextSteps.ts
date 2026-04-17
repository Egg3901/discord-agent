import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Message,
} from 'discord.js';
import { BotColors } from './embedHelpers.js';

/** Any channel that supports send() — threads, text channels, DMs. */
type SendableChannel = { send: (options: any) => Promise<Message> };

/** Tool names that indicate file modifications. */
const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'run_script', 'patch_file', 'find_replace_all', 'download_file',
  'git_commit', 'git_add', 'git_push',
  'Write', 'Edit', 'MultiEdit', 'Bash',
]);

/** Tool names that indicate reads/analysis. */
const READ_TOOLS = new Set([
  'read_file', 'read_files_batch', 'read_local_file', 'list_directory',
  'search_code', 'search_files', 'analyze_code', 'list_workspace',
  'Read', 'Glob', 'Grep', 'LS',
]);

/** Tool names that indicate git operations. */
const GIT_TOOLS = new Set([
  'git_status', 'git_diff', 'git_log', 'git_add', 'git_commit', 'git_push',
  'create_pr',
]);

/** Tool names that indicate test/build. */
const BUILD_TOOLS = new Set([
  'build_project', 'run_terminal', 'run_tests',
  'Bash',
]);

export interface ToolUsageSummary {
  toolNames: string[];
  totalCalls: number;
  elapsed: number; // ms
}

/**
 * Stable customIds for the follow-up buttons, handled globally in
 * interactionCreate. Kept as constants so the handler and the builder
 * can't drift.
 */
export const NEXT_STEP_IDS = {
  viewDiff: 'next_view_diff',
  runTests: 'next_run_tests',
  commit: 'next_commit',
  modify: 'next_modify',
} as const;

/**
 * Prompt injected into the session when each follow-up button is clicked.
 * Exported so the global interaction handler resolves the same text
 * regardless of when the user clicks.
 */
export const NEXT_STEP_PROMPTS: Record<string, string> = {
  [NEXT_STEP_IDS.viewDiff]: 'Show me the git diff of all changes made so far.',
  [NEXT_STEP_IDS.runTests]: 'Run the test suite and report the results.',
  [NEXT_STEP_IDS.commit]:
    'Review the changes, commit them with an appropriate message, push the branch, and open a pull request. Reply with the PR URL when finished.',
  [NEXT_STEP_IDS.modify]: 'Based on the code you just read, suggest and implement improvements.',
};

/**
 * Build a completion embed and contextual next-step buttons
 * based on which tools were used during the agent loop.
 */
export function buildCompletionMessage(
  userId: string,
  summary: ToolUsageSummary,
): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> | null } {
  const names = new Set(summary.toolNames);

  const hadWrites = [...names].some((n) => WRITE_TOOLS.has(n));
  const hadReads = [...names].some((n) => READ_TOOLS.has(n));
  const hadGit = [...names].some((n) => GIT_TOOLS.has(n));
  const hadBuild = [...names].some((n) => BUILD_TOOLS.has(n));

  const embed = new EmbedBuilder()
    .setColor(BotColors.Success)
    .setDescription(
      `<@${userId}> Done — **${summary.totalCalls}** tool call${summary.totalCalls !== 1 ? 's' : ''} in **${(summary.elapsed / 1000).toFixed(1)}s**`,
    );

  const buttons: ButtonBuilder[] = [];

  if (hadWrites && !hadGit) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(NEXT_STEP_IDS.viewDiff)
        .setLabel('View Diff')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (hadWrites && !hadBuild) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(NEXT_STEP_IDS.runTests)
        .setLabel('Run Tests')
        .setEmoji('🧪')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (hadWrites && !hadGit) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(NEXT_STEP_IDS.commit)
        .setLabel('Commit & Open PR')
        .setEmoji('💾')
        .setStyle(ButtonStyle.Primary),
    );
  }

  if (hadReads && !hadWrites) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(NEXT_STEP_IDS.modify)
        .setLabel('Modify Code')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  // Max 5 buttons per row
  const row = buttons.length > 0
    ? new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(0, 5))
    : null;

  return { embed, row };
}

/**
 * Send the completion message with follow-up buttons. Clicks are handled
 * globally in `interactionCreate`, so the buttons remain live for as long
 * as the session is active (no 2-minute collector timeout).
 */
export async function sendCompletionWithNextSteps(
  channel: SendableChannel,
  userId: string,
  summary: ToolUsageSummary,
): Promise<void> {
  const { embed, row } = buildCompletionMessage(userId, summary);

  const msgOptions: any = { embeds: [embed] };
  if (row) msgOptions.components = [row];

  await channel.send(msgOptions).catch(() => {});
}
