import { config } from './config.js';
import { logger } from './utils/logger.js';
import { createDiscordClient } from './bot/client.js';
import { handleReady } from './bot/events/ready.js';
import { handleInteractionCreate } from './bot/events/interactionCreate.js';
import { handleMessageCreate } from './bot/events/messageCreate.js';
import { handleReactionAdd } from './bot/events/reactionAdd.js';
import { handleGithubLinkDetect } from './bot/events/githubLinkDetect.js';
import { registerCommands } from './bot/commands/registry.js';
import { createAskCommand } from './bot/commands/ask.js';
import { createCodeCommand } from './bot/commands/code.js';
import { createSessionCommand } from './bot/commands/session.js';
import { createAdminCommand } from './bot/commands/admin.js';
import { createRepoCommand } from './bot/commands/repo.js';
import { createConfigCommand } from './bot/commands/config.js';
import { createModelCommand } from './bot/commands/model.js';
import { createHelpCommand } from './bot/commands/help.js';
import { createUsageCommand } from './bot/commands/usage.js';
import { createVersionCommand } from './bot/commands/version.js';
import { createThinkingCommand } from './bot/commands/thinking.js';
import { createCancelCommand } from './bot/commands/cancel.js';
import { createSandboxCommand } from './bot/commands/sandbox.js';
import { createExportCommand } from './bot/commands/export.js';
import { createReviewCommand } from './bot/commands/review.js';
import { createImproveCommand } from './bot/commands/improve.js';
import { createStatusCommand } from './bot/commands/status.js';
import { createRetryCommand } from './bot/commands/retry.js';
import { createPersonaCommand } from './bot/commands/persona.js';
import { createAllowDmsCommand } from './bot/commands/allowdms.js';
import { KeyPool } from './keys/keyPool.js';
import { AIClient } from './claude/aiClient.js';
import { SessionManager } from './sessions/sessionManager.js';
import { RateLimiter } from './bot/middleware/rateLimiter.js';
import { RepoFetcher } from './github/repoFetcher.js';
import { getDatabase, closeDatabase, loadConfigValues } from './storage/database.js';
import type { CommandHandler } from './bot/commands/types.js';

async function main() {
  logger.info('Starting Discord Agent...');

  // Initialize database
  getDatabase();

  // Restore persisted config values (tokens, settings set via /config or /admin)
  config.restoreFromDb(loadConfigValues());

  // Initialize core services
  const keyPool = new KeyPool(config.INITIAL_API_KEYS);
  const aiClient = new AIClient(keyPool);
  const sessionManager = new SessionManager();
  const rateLimiter = new RateLimiter();
  const repoFetcher = new RepoFetcher();

  // Create commands
  const commands: CommandHandler[] = [
    createAskCommand(aiClient, rateLimiter, sessionManager),
    createCodeCommand(sessionManager, aiClient, rateLimiter, repoFetcher),
    createSessionCommand(sessionManager, aiClient),
    createAdminCommand(keyPool, sessionManager),
    createRepoCommand(sessionManager, repoFetcher),
    createConfigCommand(),
    createModelCommand(sessionManager),
    createHelpCommand(),
    createUsageCommand(),
    createVersionCommand(),
    createThinkingCommand(sessionManager),
    createCancelCommand(sessionManager),
    createSandboxCommand(sessionManager),
    createExportCommand(sessionManager),
    createReviewCommand(aiClient, rateLimiter, repoFetcher, sessionManager),
    createImproveCommand(aiClient, rateLimiter),
    createStatusCommand(sessionManager),
    createRetryCommand(sessionManager, aiClient, rateLimiter),
    createPersonaCommand(sessionManager),
    createAllowDmsCommand(),
  ];

  const commandMap = new Map<string, CommandHandler>();
  for (const cmd of commands) {
    commandMap.set(cmd.data.name, cmd);
  }

  // Register slash commands with Discord
  await registerCommands(commands);

  // Create and configure Discord client
  const client = createDiscordClient();

  // Wire up event handlers
  handleReady(client);
  handleInteractionCreate(client, commandMap);
  handleMessageCreate(client, sessionManager, aiClient, rateLimiter, repoFetcher);
  handleReactionAdd(client, sessionManager);
  handleGithubLinkDetect(client);

  // Login
  await client.login(config.DISCORD_TOKEN);

  // Warn users when their session is about to expire
  sessionManager.setExpiryCallback((session) => {
    const channel = client.channels.cache.get(session.threadId);
    if (channel && 'send' in channel) {
      (channel as any).send('⚠️ This session will expire in ~5 minutes due to inactivity. Send a message to keep it alive.').catch(() => {});
    }
  });

  // Periodic disk cleanup (every 30 min): stale sandboxes + PM2 log rotation
  const diskCleanup = async () => {
    try {
      const { cleanupStaleSandboxes } = await import('./tools/scriptExecutor.js');
      const cleaned = await cleanupStaleSandboxes();
      if (cleaned > 0) logger.info({ cleaned }, 'Cleaned stale sandbox directories');
    } catch { /* non-fatal */ }

    // Truncate PM2 logs if they exceed 50MB
    try {
      const { stat, truncate } = await import('node:fs/promises');
      const logDir = process.env['PM2_HOME']
        ? `${process.env['PM2_HOME']}/logs`
        : `${process.env['HOME'] || '/root'}/.pm2/logs`;
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(logDir).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith('.log')) continue;
        const path = `${logDir}/${f}`;
        const s = await stat(path).catch(() => null);
        if (s && s.size > 50_000_000) {
          await truncate(path, 0);
          logger.info({ file: f, wasBytes: s.size }, 'Truncated oversized PM2 log');
        }
      }
    } catch { /* non-fatal */ }
  };
  diskCleanup(); // Run once at startup
  const cleanupTimer = setInterval(diskCleanup, 30 * 60 * 1000);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    clearInterval(cleanupTimer);
    keyPool.destroy();
    sessionManager.destroy();
    rateLimiter.destroy();
    closeDatabase();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start bot');
  process.exit(1);
});
