#!/bin/bash
# Single-instance starter for Claude Telegram Orchestrator
# Ensures only one bot process runs at a time

set -e

PIDFILE="$HOME/.claude-orchestrator/orchestrator.pid"
TOKEN_FILE="$HOME/.claude-orchestrator/.env"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

# Load env (TELEGRAM_BOT_TOKEN, ADMIN_USERS, MEMORY_PRIVATE_RULES, etc.)
if [ -f "$TOKEN_FILE" ]; then
    set -a  # auto-export everything sourced
    source "$TOKEN_FILE"
    set +a
fi
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "❌ TELEGRAM_BOT_TOKEN not set. Add it to $TOKEN_FILE or env."
    exit 1
fi
export TELEGRAM_BOT_TOKEN
# ADMIN_USERS: comma-separated Telegram user IDs allowed to manage schedules
export ADMIN_USERS="${ADMIN_USERS:-}"
# MEMORY_PRIVATE_RULES: JSON-encoded array of private memory rules. See README.
export MEMORY_PRIVATE_RULES="${MEMORY_PRIVATE_RULES:-}"
# FOOD_ANALYSIS_PROMPT: optional override for the /analyze-food endpoint prompt
export FOOD_ANALYSIS_PROMPT="${FOOD_ANALYSIS_PROMPT:-}"

# Load HTTP server auth token from vault (shared with healthy-me chat relay)
VAULT="$HOME/.openclaw/workspace/scripts/vault"
if [ -x "$VAULT" ]; then
    ORCH_TOKEN=$(bash "$VAULT" get withluna-chat-token 2>/dev/null || true)
    if [ -n "$ORCH_TOKEN" ]; then
        export ORCHESTRATOR_HTTP_TOKEN="$ORCH_TOKEN"
    fi
fi
export ORCHESTRATOR_HTTP_PORT="${ORCHESTRATOR_HTTP_PORT:-7800}"

# Kill any existing instance
echo "🔍 Checking for existing instances..."

# Kill by PID file
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "🛑 Killing existing orchestrator (PID $OLD_PID)"
        kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
fi

# Kill by process pattern (exclude start-tmux.sh wrapper so launchd monitor survives)
pgrep -f "claude-telegram-orchestrator/src/index" 2>/dev/null | while read pid; do
    [ "$pid" != "$$" ] && kill -9 "$pid" 2>/dev/null || true
done
pkill -9 -f "external_plugins/telegram/server" 2>/dev/null || true

# Release Telegram's server-side polling lock
echo "🔓 Releasing Telegram polling lock..."
curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/close" > /dev/null 2>&1 || true
curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true" > /dev/null 2>&1 || true

# Wait for everything to settle
echo "⏳ Waiting 5s for cleanup..."
sleep 5

# Start
echo "🚀 Starting orchestrator..."
cd "$PROJECT_DIR"
exec bun run src/index.ts
