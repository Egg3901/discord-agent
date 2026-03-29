import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import { BotColors, formatDuration } from './embedHelpers.js';

/** Any channel that supports send() — threads, text channels, DMs. */
type SendableChannel = { send: (options: any) => Promise<Message> };

/** Tool names that indicate file modifications. */
const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'run_script',
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
]);

/** Tool names that indicate test/build. */
const BUILD_TOOLS = new Set([
  'build_project', 'run_terminal',
  'Bash',
]);

export interface ToolUsageSummary {
  toolNames: string[];
  totalCalls: number;
  elapsed: number; // ms
}

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

  // Max 5 buttons per row
  const row = buttons.length > 0
    ? new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(0, 5))
    : null;

  return { embed, row };
}

/**
 * Send the completion message and set up button collectors
 * that inject follow-up prompts into the session.
 */
export async function sendCompletionWithNextSteps(
  channel: SendableChannel,
  userId: string,
  summary: ToolUsageSummary,
): Promise<void> {
  const { embed, row } = buildCompletionMessage(userId, summary);

  const msgOptions: any = { embeds: [embed] };
  if (row) msgOptions.components = [row];

  const msg = await channel.send(msgOptions).catch(() => null);
  if (!msg || !row) return;

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120_000, // 2 minute window
  });

  collector.on('collect', async (btn: ButtonInteraction) => {
    if (btn.user.id !== userId) {
      await btn.reply({ content: 'Only the session owner can use these.', ephemeral: true });
      return;
    }

    const prompts: Record<string, string> = {
      next_view_diff: 'Show me the git diff of all changes made so far.',
      next_run_tests: 'Run the test suite and report the results.',
      next_commit: 'Review the changes, then commit them with an appropriate message.',
      next_modify: 'Based on the code you just read, suggest and implement improvements.',
    };

    const prompt = prompts[btn.customId];
    if (prompt) {
      // Send as a regular message in the channel so the message handler picks it up
      await btn.deferUpdate();
      await channel.send(prompt);
    }

    // Disable buttons after use
    collector.stop();
  });

  collector.on('end', () => {
    msg.edit({ components: [] }).catch(() => {});
  });
}
