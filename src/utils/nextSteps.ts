import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import { BotColors } from './embedHelpers.js';
import type { PendingPrompt } from '../sessions/session.js';

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
 * Enqueue a follow-up prompt for processing by the agent loop. Returns the
 * queue position (0 = ran immediately).
 */
export type EnqueueFollowUp = (prompt: PendingPrompt) => number;

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
        .setCustomId('next_view_diff')
        .setLabel('View Diff')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (hadWrites && !hadBuild) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('next_run_tests')
        .setLabel('Run Tests')
        .setEmoji('🧪')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (hadWrites && !hadGit) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('next_commit')
        .setLabel('Commit Changes')
        .setEmoji('💾')
        .setStyle(ButtonStyle.Primary),
    );
  }

  if (hadReads && !hadWrites) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('next_modify')
        .setLabel('Modify Code')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  const row = buttons.length > 0
    ? new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(0, 5))
    : null;

  return { embed, row };
}

const PROMPTS: Record<string, { prompt: string; label: string }> = {
  next_view_diff: {
    prompt: 'Show me the git diff of all changes made so far.',
    label: '📋 View Diff',
  },
  next_run_tests: {
    prompt: 'Run the test suite and report the results.',
    label: '🧪 Run Tests',
  },
  next_commit: {
    prompt: 'Review the changes, then commit them with an appropriate message.',
    label: '💾 Commit Changes',
  },
  next_modify: {
    prompt: 'Based on the code you just read, suggest and implement improvements.',
    label: '✏️ Modify Code',
  },
};

/**
 * Send the completion message with next-step buttons. Clicks are routed
 * through `enqueueFollowUp`, which injects the prompt as a real user-role
 * message into the agent loop (either immediately or queued behind the
 * currently-running turn).
 */
export async function sendCompletionWithNextSteps(
  channel: SendableChannel,
  userId: string,
  summary: ToolUsageSummary,
  enqueueFollowUp: EnqueueFollowUp,
): Promise<void> {
  const { embed, row } = buildCompletionMessage(userId, summary);

  const msgOptions: any = { embeds: [embed] };
  if (row) msgOptions.components = [row];

  const msg = await channel.send(msgOptions).catch(() => null);
  if (!msg || !row) return;

  // Keep buttons live for the lifetime of the session (sessions prune after
  // 30 min of inactivity). Idle-reset on each click.
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    idle: 30 * 60_000,
  });

  collector.on('collect', async (btn: ButtonInteraction) => {
    if (btn.user.id !== userId) {
      await btn.reply({ content: 'Only the session owner can use these.', ephemeral: true });
      return;
    }

    const action = PROMPTS[btn.customId];
    if (!action) {
      await btn.deferUpdate().catch(() => {});
      return;
    }

    const queuePos = enqueueFollowUp({
      userId,
      content: action.prompt,
      label: action.label,
    });

    // Acknowledge the click inline (replaces the button row so the user knows
    // the action fired — avoids the "nothing happens" confusion).
    const note = queuePos > 0
      ? `*${action.label} — queued as follow-up #${queuePos}*`
      : `*${action.label} — running...*`;
    await btn.update({ embeds: [embed], components: [], content: note }).catch(async () => {
      // If update fails (e.g. original message edited), acknowledge ephemerally.
      await btn.reply({ content: note, ephemeral: true }).catch(() => {});
    });

    collector.stop('clicked');
  });

  collector.on('end', (_collected, reason) => {
    if (reason === 'clicked') return; // Already updated
    msg.edit({ components: [] }).catch(() => {});
  });
}
