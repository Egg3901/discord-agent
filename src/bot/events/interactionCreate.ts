import {
  Client,
  ChannelType,
  type Interaction,
  type ButtonInteraction,
  type ThreadChannel,
  type DMChannel,
  type TextChannel,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isAdmin } from '../middleware/permissions.js';
import { SessionManager } from '../../sessions/sessionManager.js';
import { AIClient } from '../../claude/aiClient.js';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { RepoFetcher } from '../../github/repoFetcher.js';
import { runAgentTurn } from '../agentTurn.js';
import { NEXT_STEP_PROMPTS } from '../../utils/nextSteps.js';
import type { CommandHandler } from '../commands/types.js';
import type { GuildMember } from 'discord.js';

export interface InteractionDeps {
  sessionManager: SessionManager;
  aiClient: AIClient;
  rateLimiter: RateLimiter;
  repoFetcher: RepoFetcher;
}

export function handleInteractionCreate(
  client: Client,
  commands: Map<string, CommandHandler>,
  deps: InteractionDeps,
): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    // Autocomplete
    if (interaction.isAutocomplete()) {
      const handler = commands.get(interaction.commandName);
      if (handler?.autocomplete) {
        try {
          await handler.autocomplete(interaction);
        } catch (err) {
          logger.warn({ err, command: interaction.commandName }, 'Autocomplete error');
          await interaction.respond([]).catch(() => {});
        }
      }
      return;
    }

    // Button interactions — only follow-up "next_*" buttons are handled here.
    // Buttons owned by a local awaitMessageComponent collector (e.g. /code
    // prompt-improvement flow with customIds "use_improved"/"use_original")
    // are consumed by that collector before this handler runs, so they are
    // intentionally unhandled here.
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('next_')) {
        await handleNextStepButton(interaction, deps);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const handler = commands.get(interaction.commandName);
    if (!handler) {
      logger.warn({ command: interaction.commandName }, 'Unknown command');
      return;
    }

    try {
      await handler.execute(interaction);
    } catch (err) {
      logger.error({ err, command: interaction.commandName }, 'Command error');

      const content = 'An error occurred while processing your command.';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  });
}

async function handleNextStepButton(
  btn: ButtonInteraction,
  deps: InteractionDeps,
): Promise<void> {
  const prompt = NEXT_STEP_PROMPTS[btn.customId];
  if (!prompt) {
    await btn.reply({ content: 'This button is no longer supported.', ephemeral: true }).catch(() => {});
    return;
  }

  if (!isAdmin(btn.member as GuildMember | null)) {
    await btn.reply({ content: 'This action requires administrator permissions.', ephemeral: true }).catch(() => {});
    return;
  }

  const channel = btn.channel;
  if (!channel) {
    await btn.reply({ content: 'Could not access the channel.', ephemeral: true }).catch(() => {});
    return;
  }

  const isThread =
    channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread;
  const isDm = channel.type === ChannelType.DM;
  if (!isThread && !isDm) {
    await btn.reply({ content: 'This button only works inside a coding session.', ephemeral: true }).catch(() => {});
    return;
  }

  const session = deps.sessionManager.getByThread(channel.id);
  if (!session) {
    await btn.reply({ content: 'This session has expired. Start a new one with /code.', ephemeral: true }).catch(() => {});
    return;
  }

  if (session.userId !== btn.user.id) {
    await btn.reply({ content: 'Only the session owner can use these buttons.', ephemeral: true }).catch(() => {});
    return;
  }

  if (session.busy) {
    await btn.reply({
      content: 'Still working on the previous request. Wait for it to finish (or react 🛑 to cancel).',
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  if (!deps.rateLimiter.check(btn.user.id)) {
    await btn.reply({ content: 'You\'re clicking too fast — please wait a moment.', ephemeral: true }).catch(() => {});
    return;
  }

  // Acknowledge the click silently, then disable the buttons on the original
  // message so they can't be re-clicked mid-run.
  try {
    await btn.update({ components: [] });
  } catch {
    // If the interaction already timed out (>3s since creation), fall back to deferReply.
    await btn.deferUpdate().catch(() => {});
  }

  await runAgentTurn(
    {
      sessionManager: deps.sessionManager,
      aiClient: deps.aiClient,
      repoFetcher: deps.repoFetcher,
    },
    session,
    {
      channel: channel as ThreadChannel | DMChannel | TextChannel,
      userId: btn.user.id,
      content: prompt,
    },
  );
}
