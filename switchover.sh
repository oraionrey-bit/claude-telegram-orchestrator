#!/bin/bash
# switchover.sh — Kill the Claude Channels plugin session and start the orchestrator
#
# This script:
# 1. Kills the tmux "claude-channels" session (single-instance Claude + telegram plugin)
# 2. Waits for Telegram polling lock to release
# 3. Starts the orchestrator (Bun process that spawns per-chat/topic Claude sessions)
#
# Safe to run multiple times — it's idempotent.
# The orchestrator's start.sh also handles killing stale processes.
#
# After running, the orchestrator will:
# - Poll Telegram via Grammy
# - Route DMs to dm-{user_id} sessions
# - Route group messages to group-{chat_id} or group-{chat_id}-topic-{thread_id} sessions
# - Spawn isolated `claude --print --input-format stream-json --output-format stream-json` per session
# - Config: ~/.claude-orchestrator/config.json
# - Logs: ~/.claude-orchestrator/logs/
#
# To verify it's working:
#   ps aux | grep claude-telegram-orchestrator
#   cat ~/.claude-orchestrator/logs/orchestrator.log
#   Send a message to @Oraion_claudebot on Telegram

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

echo "=== Switchover: Claude Channels → Orchestrator ==="
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Step 1: Kill the claude-channels tmux session
echo ""
echo "Step 1: Stopping claude-channels tmux session..."
if tmux has-session -t claude-channels 2>/dev/null; then
    tmux kill-session -t claude-channels
    echo "  ✅ Killed tmux session 'claude-channels'"
else
    echo "  ⏭  No 'claude-channels' tmux session found (already stopped)"
fi

# Step 2: Kill any lingering telegram plugin or claude --channels processes
echo ""
echo "Step 2: Killing lingering telegram plugin processes..."
pkill -f "external_plugins/telegram" 2>/dev/null && echo "  ✅ Killed telegram plugin" || echo "  ⏭  No telegram plugin process"
pkill -f "claude.*--channels.*telegram" 2>/dev/null && echo "  ✅ Killed claude channels" || echo "  ⏭  No claude channels process"

# Step 3: Wait for Telegram to release the polling lock
echo ""
echo "Step 3: Waiting 5s for Telegram polling lock release..."
sleep 5

# Step 4: Start the orchestrator in a new tmux session
echo ""
echo "Step 4: Starting orchestrator in tmux session 'orchestrator'..."

# Kill existing orchestrator tmux if any
tmux kill-session -t orchestrator 2>/dev/null || true

tmux new-session -d -s orchestrator -c "$SCRIPT_DIR" "$SCRIPT_DIR/start.sh"
echo "  ✅ Started orchestrator in tmux session 'orchestrator'"

# Step 5: Wait and verify
echo ""
echo "Step 5: Waiting 10s for startup, then verifying..."
sleep 10

if pgrep -f "claude-telegram-orchestrator/src/index" > /dev/null 2>&1; then
    PID=$(pgrep -f "claude-telegram-orchestrator/src/index" | head -1)
    echo "  ✅ Orchestrator running (PID $PID)"
else
    echo "  ⚠️  Orchestrator process not found — check logs:"
    echo "     cat ~/.claude-orchestrator/logs/orchestrator.log"
    echo "     tmux attach -t orchestrator"
fi

echo ""
echo "=== Switchover complete ==="
echo ""
echo "To monitor:  tmux attach -t orchestrator"
echo "To check:    cat ~/.claude-orchestrator/logs/orchestrator.log"
echo "To stop:     tmux kill-session -t orchestrator"
echo "To restart:  $SCRIPT_DIR/switchover.sh"
echo ""
echo "To revert to Claude Channels (old setup):"
echo "  tmux kill-session -t orchestrator"
echo "  tmux new-session -d -s claude-channels -c ~/.openclaw/workspace \\"
echo "    'claude --permission-mode bypassPermissions --channels plugin:telegram@claude-plugins-official'"
