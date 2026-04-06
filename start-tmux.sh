#!/bin/bash
# Wrapper: starts orchestrator in tmux and waits for the session to die.
# Managed by launchd — if the tmux session exits, this exits non-zero to trigger restart.
#
# Usage:
#   launchctl start com.oraion.claude-orchestrator   # start
#   launchctl stop com.oraion.claude-orchestrator    # stop
#   tmux attach -t orchestrator                      # inspect live

SESSION="orchestrator"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMUX="/opt/homebrew/bin/tmux"
PIDFILE="$HOME/.claude-orchestrator/orchestrator.pid"
LOCKFILE="$HOME/.claude-orchestrator/.start.lock"

# Prevent concurrent starts using mkdir atomicity
if ! mkdir "$LOCKFILE" 2>/dev/null; then
    # Check if the lock holder is still alive
    LOCK_PID=$(cat "$LOCKFILE/pid" 2>/dev/null)
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "Another start-tmux.sh is already running (PID $LOCK_PID). Exiting."
        exit 0
    fi
    # Stale lock — remove and retry
    rm -rf "$LOCKFILE"
    mkdir "$LOCKFILE" 2>/dev/null || { echo "Cannot acquire lock. Exiting."; exit 0; }
fi
echo $$ > "$LOCKFILE/pid"
trap 'rm -rf "$LOCKFILE"' EXIT

# If orchestrator is already running healthy in tmux, just monitor it
if $TMUX has-session -t "$SESSION" 2>/dev/null; then
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE" 2>/dev/null)
        if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
            echo "Orchestrator already running (PID $PID) in tmux. Monitoring..."
            while $TMUX has-session -t "$SESSION" 2>/dev/null; do
                sleep 5
            done
            echo "Tmux session died. Restarting..."
            exit 1
        fi
    fi
    # Tmux session exists but process is dead — kill stale session
    echo "Stale tmux session found. Cleaning up..."
    $TMUX kill-session -t "$SESSION" 2>/dev/null || true
    sleep 2
fi

# Start a new detached tmux session running start.sh
echo "Starting orchestrator in tmux..."
$TMUX new-session -d -s "$SESSION" -c "$PROJECT_DIR" "$PROJECT_DIR/start.sh"

# Wait for it to initialize
sleep 10

# Verify it started
if ! $TMUX has-session -t "$SESSION" 2>/dev/null; then
    echo "Tmux session failed to start."
    exit 1
fi

echo "Orchestrator started. Monitoring tmux session..."

# Monitor — if tmux session dies, exit non-zero so launchd restarts
while $TMUX has-session -t "$SESSION" 2>/dev/null; do
    sleep 5
done

echo "Orchestrator tmux session exited. Restarting..."
exit 1
