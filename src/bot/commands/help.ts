import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { splitMessage } from '../../utils/chunks.js';
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
> \`/review <pr>\` — Review a GitHub PR (URL or \`owner/repo#123\`)
> \`/repo <url> [paths]\` — Attach a GitHub repo as context to current session
> \`/model <model> [scope]\` — Switch Claude model (this session or default)
> \`/session end\` — End your current session
> \`/session status\` — View your active sessions
> \`/sandbox [path]\` — List files in the current session's sandbox workspace
> \`/export\` — Export this session conversation as a markdown file
> \`/usage [period] [all]\` — View your token usage and costs
> \`/config set <key> <value>\` — Set a runtime config value
> \`/config list\` — Show settable config keys
> \`/version\` — Show bot version, uptime, and latest commit
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

**Code Execution Sandbox:**
• When enabled, the bot can run scripts, write/read files, and build multi-file projects in an isolated workspace
• Supports Python, JavaScript, TypeScript, Bash, Ruby, and Perl
• Enable with \`/config set ENABLE_SCRIPT_EXECUTION true\`

**Tips:**
• Attach code files (.ts, .py, .js, etc.) to messages — they're included as context
• Responses stream in real-time; tool calls show inline progress with results
• Multi-step tasks ping you when complete so you can step away
• If all keys are busy, you'll see your queue position
• Sessions auto-expire after 30 minutes of inactivity
• API keys, role settings, and model overrides survive bot restarts
• Use \`/model\` to switch between Opus, Sonnet, and Haiku mid-session
• Use \`/export\` to save a session as markdown for sharing or archiving`;

      const chunks = splitMessage(help);
      await interaction.reply({ content: chunks[0], ephemeral: true });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i], ephemeral: true });
      }
    },
  };
}
