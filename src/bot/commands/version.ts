import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { isAdmin } from '../middleware/permissions.js';
import { formatApiError } from '../../utils/errors.js';
import { BotColors, formatDuration } from '../../utils/embedHelpers.js';
import type { CommandHandler } from './types.js';

const startTime = Date.now();

function getPackageVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function getGitCommit(): { hash: string; date: string; message: string } | null {
  try {
    const raw = execSync('git log -1 --format="%h|%ci|%s"', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const [hash, date, ...rest] = raw.split('|');
    return { hash, date, message: rest.join('|') };
  } catch {
    return null;
  }
}

export function createVersionCommand(): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('version')
      .setDescription('Show bot version, uptime, and recent commit info'),

    async execute(interaction: ChatInputCommandInteraction) {
      if (!isAdmin(interaction.member as GuildMember | null)) {
        await interaction.reply({
          content: 'This command requires administrator permissions.',
          ephemeral: true,
        });
        return;
      }

      try {
        const version = getPackageVersion();
        const uptime = formatDuration(Date.now() - startTime);
        const commit = getGitCommit();

        const embed = new EmbedBuilder()
          .setColor(BotColors.Primary)
          .setTitle(`Discord Agent v${version}`)
          .addFields(
            { name: 'Uptime', value: uptime, inline: true },
          )
          .setTimestamp();

        if (commit) {
          embed.addFields(
            { name: 'Latest Commit', value: `\`${commit.hash}\` — ${commit.message}`, inline: false },
            { name: 'Commit Date', value: commit.date, inline: true },
          );
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (err) {
        const msg = formatApiError(err);
        if (interaction.deferred) {
          await interaction.editReply(msg).catch(() => {});
        } else {
          await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        }
      }
    },
  };
}
