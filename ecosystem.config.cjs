// PM2 ecosystem config for Discord Agent
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'discord-agent',
      script: 'dist/index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // Logging
      error_file: './logs/bot-error.log',
      out_file: './logs/bot-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'update-watcher',
      script: './scripts/update-watcher.sh',
      cwd: __dirname,
      interpreter: 'bash',
      env: {
        PM2_APP_NAME: 'discord-agent',
        WATCH_BRANCH: 'main',
        POLL_INTERVAL: '30',
      },
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000,
      // Logging
      error_file: './logs/watcher-error.log',
      out_file: './logs/watcher-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
