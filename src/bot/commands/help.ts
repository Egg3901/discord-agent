import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { BotColors } from '../../utils/embedHelpers.js';
import type { CommandHandler } from './types.js';

const pages: { title: string; emoji: string; embed: () => EmbedBuilder }[] = [
  {
    title: 'Getting Started',
    emoji: '🚀',
    embed: () =>
      new EmbedBuilder()
        .setColor(BotColors.Primary)
        .setTitle('Discord Agent — Getting Started')
        .setDescription(
          'Use `/code` to start a threaded coding session. Follow-up messages in the thread continue the conversation — no slash command needed after the first message.\n\n' +
          'Attach code files directly to messages for automatic context inclusion.',
        )
        .addFields(
          { name: '`/code <prompt> [repo]`', value: 'Start a coding session in a new thread', inline: false },
          { name: '`/ask <question>`', value: 'One-shot question — quick answer, no session', inline: false },
          { name: '`/review <pr>`', value: 'Review a GitHub PR with follow-up capability', inline: false },
        ),
  },
  {
    title: 'Commands',
    emoji: '⚡',
    embed: () =>
      new EmbedBuilder()
        .setColor(BotColors.Info)
        .setTitle('Commands')
        .addFields(
          { name: 'Sessions', value: [
            '`/code <prompt> [repo]` — Start coding session (auto-improves prompt)',
            '`/ask <question>` — One-shot question',
            '`/review <pr>` — Review a GitHub PR',
            '`/improve <prompt>` — Preview AI-improved prompt',
          ].join('\n') },
          { name: 'Session Management', value: [
            '`/session end` — End current session',
            '`/session status` — View active sessions',
            '`/session reset` — Clear history, start fresh',
            '`/retry` — Re-generate last response',
            '`/cancel` — Abort in-flight request',
            '`/export` — Download session as markdown',
          ].join('\n') },
          { name: 'Configuration', value: [
            '`/model <model> [scope]` — Switch model (session or default)',
            '`/repo <url> [paths]` — Attach GitHub repo context',
            '`/persona set/clear/show` — Custom system prompt',
            '`/thinking on/off [budget]` — Extended thinking toggle',
            '`/basebranch [branch]` — Set/view base branch for PRs',
            '`/sandbox [path]` — List sandbox workspace files',
          ].join('\n') },
          { name: 'Info', value: [
            '`/status` — Session info (model, repo, messages)',
            '`/usage [period]` — Token usage and costs',
            '`/version` — Bot version and uptime',
          ].join('\n') },
        ),
  },
  {
    title: 'Admin',
    emoji: '🔧',
    embed: () =>
      new EmbedBuilder()
        .setColor(BotColors.Admin)
        .setTitle('Admin Commands')
        .setDescription('Requires **Administrator** permission.')
        .addFields(
          { name: 'API Keys', value: [
            '`/admin addkey <key> [provider]` — Add API key',
            '`/admin removekey <id>` — Remove key',
            '`/admin keys` — List keys with health status',
          ].join('\n') },
          { name: 'Access Control', value: [
            '`/admin allowrole @role` — Restrict bot to a role',
            '`/admin denyrole @role` — Remove restriction',
            '`/admin roles` — List allowed roles',
            '`/allowdms add/remove/list` — Manage DM allowlist',
          ].join('\n') },
          { name: 'Management', value: [
            '`/admin stats` — Bot statistics',
            '`/admin prune` — Force-prune stale sessions',
            '`/admin setgittoken <token>` — Set GitHub token',
            '`/config set/list` — Runtime configuration',
          ].join('\n') },
        ),
  },
  {
    title: 'Models & Tips',
    emoji: '💡',
    embed: () =>
      new EmbedBuilder()
        .setColor(BotColors.Session)
        .setTitle('Models & Tips')
        .addFields(
          { name: 'Available Models', value: [
            '**Claude Code** (default, uses Max plan):',
            '> `claude-code`, `claude-code-sonnet`, `claude-code-opus`, `claude-code-haiku`',
            '**Anthropic API** (requires API key):',
            '> `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5`',
            '**Google** (requires Google API key):',
            '> `gemini-2.5-pro`, `gemini-2.5-flash`',
          ].join('\n') },
          { name: 'Tips', value: [
            '• Attach code files — they\'re included as context automatically',
            '• Responses stream in real-time with inline tool progress',
            '• Multi-step tasks ping you when complete',
            '• Sessions auto-expire after 30 min of inactivity',
            '• Settings and keys survive bot restarts',
            '• GitHub links in channels get auto-detected with action buttons',
            '• After tool execution, use suggested next-step buttons',
          ].join('\n') },
        ),
  },
];

export function createHelpCommand(): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show all available commands and how to use the bot'),

    async execute(interaction: ChatInputCommandInteraction) {
      let currentPage = 0;

      function buildRow() {
        return new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...pages.map((page, i) =>
            new ButtonBuilder()
              .setCustomId(`help_page_${i}`)
              .setLabel(page.title)
              .setEmoji(page.emoji)
              .setStyle(i === currentPage ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        );
      }

      const reply = await interaction.reply({
        embeds: [pages[currentPage].embed().setFooter({ text: `Page ${currentPage + 1}/${pages.length} • Discord Agent` })],
        components: [buildRow()],
        ephemeral: true,
      });

      const collector = (await interaction.fetchReply()).createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 300_000, // 5 minute window
      });

      collector.on('collect', async (btn) => {
        const pageIdx = parseInt(btn.customId.replace('help_page_', ''), 10);
        if (isNaN(pageIdx) || pageIdx < 0 || pageIdx >= pages.length) return;

        currentPage = pageIdx;
        await btn.update({
          embeds: [pages[currentPage].embed().setFooter({ text: `Page ${currentPage + 1}/${pages.length} • Discord Agent` })],
          components: [buildRow()],
        });
      });

      collector.on('end', () => {
        interaction.editReply({ components: [] }).catch(() => {});
      });
    },
  };
}
