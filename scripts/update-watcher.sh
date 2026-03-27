#!/usr/bin/env bash
# update-watcher.sh — Polls origin/main for new commits and auto-restarts the bot via PM2.
# Designed to run as a separate PM2 process alongside the bot.
#
# Usage: PM2_APP_NAME=discord-agent ./scripts/update-watcher.sh
# Or just run via the ecosystem.config.cjs

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${WATCH_BRANCH:-main}"
POLL_INTERVAL="${POLL_INTERVAL:-30}"          # seconds between checks
PM2_APP_NAME="${PM2_APP_NAME:-discord-agent}" # name of the bot process in PM2

cd "$REPO_DIR"

echo "[update-watcher] Watching branch '$BRANCH' every ${POLL_INTERVAL}s"
echo "[update-watcher] Will restart PM2 app '$PM2_APP_NAME' on updates"
echo "[update-watcher] Repo: $REPO_DIR"

while true; do
  sleep "$POLL_INTERVAL"

  # Fetch latest from remote
  if ! git fetch origin "$BRANCH" --quiet 2>/dev/null; then
    echo "[update-watcher] git fetch failed, retrying in ${POLL_INTERVAL}s..."
    continue
  fi

  LOCAL_HEAD=$(git rev-parse HEAD)
  REMOTE_HEAD=$(git rev-parse "origin/$BRANCH")

  if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
    continue
  fi

  echo "[update-watcher] Update detected!"
  echo "[update-watcher] Local:  $LOCAL_HEAD"
  echo "[update-watcher] Remote: $REMOTE_HEAD"

  # Pull latest changes
  if ! git pull origin "$BRANCH" --ff-only; then
    echo "[update-watcher] git pull failed (possible conflicts). Trying hard reset..."
    git reset --hard "origin/$BRANCH"
  fi

  # Install deps if package.json changed
  if git diff "$LOCAL_HEAD" "$REMOTE_HEAD" --name-only | grep -q "package.json"; then
    echo "[update-watcher] package.json changed, running npm install..."
    npm install --production
  fi

  # Rebuild TypeScript
  echo "[update-watcher] Building..."
  if ! npm run build; then
    echo "[update-watcher] Build failed! Skipping restart."
    continue
  fi

  # Restart the bot via PM2
  echo "[update-watcher] Restarting PM2 app '$PM2_APP_NAME'..."
  pm2 restart "$PM2_APP_NAME"

  echo "[update-watcher] Done. Bot restarted with latest code."
done
