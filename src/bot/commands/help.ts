import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandHandler } from './types.js';

export function createHelpCommand(): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show all available commands and how to use the bot'),

    async execute(interaction: ChatInputCommandInteraction) {
      const help = `**Discord Agent — Claude Code via Discord**

**Getting Started:**
Use \`/code\` to start a threaded coding session. Follow-up messages in the thread continue the conversation — no slash command needed after the first message. You can also attach code files directly.

**Commands:**
> \`/ask <question>\` — One-shot question (no session, quick answer)
> \`/code <prompt> [repo]\` — Start a coding session in a new thread
> \`/repo <url> [paths]\` — Attach a GitHub repo as context to current session
> \`/model <model> [scope]\` — Switch Claude model (this session or default)
> \`/session end\` — End your current session
> \`/session status\` — View your active sessions
> \`/help\` — This message

**Admin Commands (requires Administrator):**
> \`/admin addkey <key>\` — Add an Anthropic API key (persisted across restarts)
> \`/admin removekey <id>\` — Remove an API key
> \`/admin keys\` — List keys and health status
> \`/admin allowrole @role\` — Restrict bot usage to a role
> \`/admin denyrole @role\` — Remove a role restriction
> \`/admin roles\` — List allowed roles
> \`/admin stats\` — Bot statistics
> \`/admin prune\` — Force-prune stale sessions
> \`/config set <key> <value>\` — Set a config value (values never displayed)
> \`/config list\` — Show settable config keys

**Tips:**
• Attach code files (.ts, .py, .js, etc.) to messages — they're included as context
• Responses stream in real-time with progress updates
• If all keys are busy, you'll see your queue position
• Sessions auto-expire after 30 minutes of inactivity
• API keys and role settings survive bot restarts
• Use \`/model\` to switch between Opus, Sonnet, and Haiku mid-session`;

      await interaction.reply({ content: help, ephemeral: true });
    },
  };
}
