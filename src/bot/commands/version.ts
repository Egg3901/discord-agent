import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
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

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

export function createVersionCommand(): CommandHandler {
  return {
    data: new SlashCommandBuilder()
      .setName('version')
      .setDescription('Show bot version, uptime, and recent commit info'),

    async execute(interaction: ChatInputCommandInteraction) {
      const version = getPackageVersion();
      const uptime = formatUptime(Date.now() - startTime);
      const commit = getGitCommit();

      let text = `**Discord Agent v${version}**\n`;
      text += `**Uptime:** ${uptime}\n`;

      if (commit) {
        text += `**Latest Commit:** \`${commit.hash}\` — ${commit.message}\n`;
        text += `**Commit Date:** ${commit.date}`;
      }

      await interaction.reply({ content: text, ephemeral: true });
    },
  };
}
