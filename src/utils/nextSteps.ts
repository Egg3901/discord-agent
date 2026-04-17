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

export interface CompletionOptions {
  /**
   * Invoked when the user clicks a next-step button. Receives the synthetic
   * prompt for that action. The caller is responsible for driving it through
   * the session pipeline (Discord's messageCreate event filters bot-authored
   * messages, so button follow-ups cannot rely on channel.send).
   */
  onFollowUp?: (prompt: string) => Promise<void> | void;
}

const NEXT_STEP_PROMPTS: Record<string, string> = {
  next_view_diff: 'Show me the git diff of all changes made so far.',
  next_run_tests: 'Run the test suite and report the results.',
  next_commit: 'Review the changes, then commit them with an appropriate message.',
  next_modify: 'Based on the code you just read, suggest and implement improvements.',
};

const NEXT_STEP_ACK: Record<string, string> = {
  next_view_diff: '📋 Showing diff of changes…',
  next_run_tests: '🧪 Running tests…',
  next_commit: '💾 Committing changes…',
  next_modify: '✏️ Planning modifications…',
};

/**
 * Send the completion message and set up button collectors
 * that inject follow-up prompts into the session.
 */
export async function sendCompletionWithNextSteps(
  channel: SendableChannel,
  userId: string,
  summary: ToolUsageSummary,
  options: CompletionOptions = {},
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

    const prompt = NEXT_STEP_PROMPTS[btn.customId];
    if (!prompt) {
      await btn.deferUpdate().catch(() => {});
      collector.stop();
      return;
    }

    // Acknowledge and disable buttons on the completion message so the user
    // can see the action fired and can't double-click.
    await btn.update({ components: [] }).catch(() => {});
    collector.stop();

    // Surface the triggered prompt so the user has context for the response
    // that follows. This is visible in the channel as a bot message.
    const ack = NEXT_STEP_ACK[btn.customId] ?? `> ${prompt}`;
    await channel.send(ack).catch(() => {});

    if (options.onFollowUp) {
      try {
        await options.onFollowUp(prompt);
      } catch {
        // Errors are surfaced by the follow-up pipeline itself.
      }
    } else {
      // No handler wired up — degrade gracefully instead of silently dropping.
      await channel.send(
        '*Next-step action is not available in this context. Send the prompt manually to continue.*',
      ).catch(() => {});
    }
  });

  collector.on('end', () => {
    msg.edit({ components: [] }).catch(() => {});
  });
}
