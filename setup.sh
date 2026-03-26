#!/bin/bash
# Interactive setup script for discord-agent
# Creates .env file by prompting for each value

set -e

ENV_FILE=".env"

echo "=== Discord Agent Setup ==="
echo "This will create your .env configuration file."
echo "Press Enter to skip optional values."
echo ""

# Required
read -p "Discord Bot Token (required): " DISCORD_TOKEN
if [ -z "$DISCORD_TOKEN" ]; then
  echo "Error: Discord Bot Token is required."
  exit 1
fi

read -p "Discord Client ID (required): " DISCORD_CLIENT_ID
if [ -z "$DISCORD_CLIENT_ID" ]; then
  echo "Error: Discord Client ID is required."
  exit 1
fi

# Optional
read -p "Discord Guild/Server ID (optional, faster command registration for dev): " DISCORD_GUILD_ID
read -p "Admin Discord User ID(s) (comma-separated, for /admin and /config commands): " ADMIN_USER_IDS
read -p "GitHub Token (optional, for /repo context fetching): " GITHUB_TOKEN

read -p "Default Claude Model [claude-sonnet-4-20250514]: " ANTHROPIC_MODEL
ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-claude-sonnet-4-20250514}

read -p "Max sessions per user [3]: " MAX_SESSIONS_PER_USER
MAX_SESSIONS_PER_USER=${MAX_SESSIONS_PER_USER:-3}

read -p "Max requests per minute per user [10]: " MAX_REQUESTS_PER_MINUTE
MAX_REQUESTS_PER_MINUTE=${MAX_REQUESTS_PER_MINUTE:-10}

# Write .env
cat > "$ENV_FILE" << EOF
# Discord Bot
DISCORD_TOKEN=${DISCORD_TOKEN}
DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}
DISCORD_GUILD_ID=${DISCORD_GUILD_ID}

# Anthropic — API keys are managed via /admin addkey in Discord
# You can optionally pre-load keys here (comma-separated), or leave blank
ANTHROPIC_API_KEYS=
ANTHROPIC_MODEL=${ANTHROPIC_MODEL}

# GitHub (optional)
GITHUB_TOKEN=${GITHUB_TOKEN}

# Admin Discord User IDs
ADMIN_USER_IDS=${ADMIN_USER_IDS}

# Limits
MAX_SESSIONS_PER_USER=${MAX_SESSIONS_PER_USER}
MAX_REQUESTS_PER_MINUTE=${MAX_REQUESTS_PER_MINUTE}
MAX_CONTEXT_TOKENS=100000

# Storage
DB_PATH=./data/bot.db
EOF

echo ""
echo "Created ${ENV_FILE} successfully!"
echo ""
echo "NEXT STEPS:"
echo "  1. Start the bot:  npm start"
echo "  2. In Discord, run:  /admin addkey <your-anthropic-api-key>"
echo "  3. You're ready to go — use /code or /ask"
