import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors } from 'discord.js';

// Brand colors used consistently across all embeds
export const BotColors = {
  Primary: 0x5865F2,    // Discord blurple
  Success: Colors.Green,
  Warning: Colors.Yellow,
  Error: Colors.Red,
  Info: 0x3498DB,       // Calm blue
  Session: 0x9B59B6,    // Purple
  Admin: 0xE67E22,      // Orange
  GitHub: 0x24292E,     // GitHub dark
  Neutral: 0x95A5A6,    // Gray
} as const;

/** Create a standard bot embed with consistent branding. */
export function botEmbed(title?: string) {
  const embed = new EmbedBuilder()
    .setTimestamp()
    .setFooter({ text: 'Discord Agent' });
  if (title) embed.setTitle(title);
  return embed;
}

/** Format a duration in ms to a human-readable string like "2h 15m". */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Format a token count with locale separators. */
export function formatTokens(n: number): string {
  return n.toLocaleString();
}

/** Format a cost in USD. */
export function formatCost(usd: number): string {
  if (usd <= 0) return 'N/A';
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

/** Create a progress bar using Unicode blocks. */
export function progressBar(current: number, max: number, length = 10): string {
  const ratio = Math.min(current / max, 1);
  const filled = Math.round(ratio * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled) + ` ${Math.round(ratio * 100)}%`;
}

/** Create a standard error embed. */
export function errorEmbed(message: string, detail?: string) {
  const embed = botEmbed('Error')
    .setColor(BotColors.Error)
    .setDescription(message);
  if (detail) embed.addFields({ name: 'Details', value: detail.slice(0, 1024) });
  return embed;
}

/** Create a standard success embed. */
export function successEmbed(message: string) {
  return botEmbed()
    .setColor(BotColors.Success)
    .setDescription(`${message}`);
}

/** Create a rate limit embed with quota info. */
export function rateLimitEmbed(info: { remaining: number; limit: number; retryAfterMs: number }) {
  const retrySeconds = Math.ceil(info.retryAfterMs / 1000);
  return botEmbed('Rate Limit Reached')
    .setColor(BotColors.Warning)
    .setDescription('You\'re sending requests too quickly.')
    .addFields(
      { name: 'Quota', value: `${info.remaining}/${info.limit} per minute`, inline: true },
      { name: 'Retry In', value: `${retrySeconds}s`, inline: true },
    );
}

/** Build a row of navigation buttons for paginated content. */
export function paginationRow(currentPage: number, totalPages: number, prefix: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}_prev`)
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}_page`)
      .setLabel(`${currentPage + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${prefix}_next`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1),
  );
}
