# Claude Telegram Orchestrator

A multi-session Telegram bot that spawns isolated Claude Code processes per chat. Each DM, group, and forum topic gets its own Claude Code session with independent context, memory, and working directory.

Built with [Grammy](https://grammy.dev/) (Telegram Bot API) and [Bun](https://bun.sh/) runtime.

## Why

Claude Code's built-in Telegram channel plugin runs a single session for all chats. This means:
- All users share one context window
- Group topics bleed into DMs
- One long conversation blocks others
- No per-user memory isolation

The orchestrator fixes this by running Claude Code as a headless subprocess per chat, routing messages via stdin/stdout using the `stream-json` protocol.

## Architecture

```
Telegram Bot API
      │
      ▼
┌─────────────────────────────────┐
│  Orchestrator (Bun + Grammy)    │
│                                 │
│  ┌───────────┐  ┌────────────┐  │
│  │  Router   │  │  Session   │  │
│  │           │  │  Manager   │  │
│  │ DM/Group/ │  │            │  │
│  │ Topic →   │──│ Spawn/Kill │  │
│  │ SessionKey│  │ LRU Evict  │  │
│  └───────────┘  │ Idle Timer │  │
│                 └─────┬──────┘  │
└───────────────────────┼─────────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
   ┌────────────┐ ┌────────────┐ ┌────────────┐
   │ Claude Code│ │ Claude Code│ │ Claude Code│
   │ Session 1  │ │ Session 2  │ │ Session N  │
   │ dm-123     │ │ dm-456     │ │ group-topic│
   │            │ │            │ │            │
   │ stdin ←──  │ │ stdin ←──  │ │ stdin ←──  │
   │ stdout ──→ │ │ stdout ──→ │ │ stdout ──→ │
   └────────────┘ └────────────┘ └────────────┘
```

Each Claude Code session runs as:
```bash
claude --print --verbose \
  --input-format stream-json --output-format stream-json \
  --permission-mode bypassPermissions \
  --model opus \
  --mcp-config ~/.claude/mcp_servers.json \
  [--resume <session-id>]
```

## Features

- **Per-chat isolation** — Each DM, group, and forum topic gets its own Claude Code process
- **Session resume** — Sessions persist across restarts via `--resume` with stored session IDs
- **Image support** — Photos sent via Telegram are downloaded, base64-encoded, and passed to Claude as image content blocks
- **Streaming responses** — Responses stream in real-time, editing a Telegram message as Claude generates text
- **LRU eviction** — When max sessions is reached, the least-recently-used session is killed
- **Idle timeout** — Sessions are automatically killed after configurable idle time
- **Forum topics** — Full support for Telegram forum/topic groups (each topic = separate session)
- **Access control** — Allowlist of Telegram user IDs
- **Group mention filter** — Configurable mention patterns for group chats
- **MCP tools** — Sessions inherit MCP server config (e.g., olog memory system)
- **Channel logging** — All messages logged to per-session text files
- **Orchestrator commands** — `/kill`, `/restart`, `/sessions`, `/help` handled at orchestrator level
- **launchd auto-restart** — Plist + tmux wrapper for crash recovery

## Setup

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Telegram bot token from [@BotFather](https://t.me/BotFather)

### Install

```bash
git clone git@github.com:oraionrey-bit/claude-telegram-orchestrator.git
cd claude-telegram-orchestrator
bun install
```

### Configure

1. Set your bot token and other env vars. Copy `.env.example` from the repo to
   `~/.claude-orchestrator/.env` and fill in real values:
   ```bash
   mkdir -p ~/.claude-orchestrator
   cp .env.example ~/.claude-orchestrator/.env
   $EDITOR ~/.claude-orchestrator/.env
   ```

   Supported env vars:

   | Var | Required | Description |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | yes | Bot token from @BotFather |
   | `ADMIN_USERS` | no | Comma-separated Telegram user IDs allowed to manage schedules |
   | `MEMORY_PRIVATE_RULES` | no | JSON array describing per-file access rules for `~/.claude-orchestrator/memory/private/` (see `.env.example`) |
   | `FOOD_ANALYSIS_PROMPT` | no | Override for `/analyze-food` HTTP endpoint prompt (must produce same JSON shape) |
   | `ORCHESTRATOR_HTTP_PORT` | no | Port for the HTTP server (default `7800`) |
   | `ORCHESTRATOR_HTTP_TOKEN` | no | Bearer token gating `/analyze-food`. If unset, endpoint is open. |

   `start.sh` auto-exports everything in `~/.claude-orchestrator/.env`.

2. Edit config:
   ```bash
   vim ~/.claude-orchestrator/config.json
   ```

   ```json
   {
     "allowedUsers": ["YOUR_TELEGRAM_USER_ID"],
     "ackReaction": "👀",
     "maxSessions": 20,
     "idleTimeoutMinutes": 1440,
     "defaultModel": "opus",
     "groups": {
       "-100XXXXXXXXXX": {
         "enabled": true,
         "requireMention": false,
         "mentionPatterns": ["botname"]
       }
     }
   }
   ```

3. Create shared identity (symlinked into all sessions):
   ```bash
   vim ~/.claude-orchestrator/CLAUDE.md
   ```

### Run

```bash
# Direct
bun run start

# Via tmux (recommended)
./start.sh

# Via launchd (auto-restart on crash)
cp com.oraion.claude-orchestrator.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.oraion.claude-orchestrator.plist
```

### CLI

```bash
bun run start          # Start orchestrator
bun run status         # Show running sessions
bun run stop           # Graceful shutdown
```

### Telegram Commands

| Command | Level | Description |
|---------|-------|-------------|
| `/kill` | Orchestrator | Kill current session (next message resumes) |
| `/restart` | Orchestrator | Same as /kill |
| `/sessions` | Orchestrator | Show all active sessions |
| `/help` | Orchestrator | List available commands |
| `/compact` | Claude Code | Compress conversation context |
| `/cost` | Claude Code | Show session cost |

## Session Routing

| Chat Type | Session Key | Example |
|-----------|-------------|---------|
| DM | `dm-{user_id}` | `dm-12345678` |
| Group (no topics) | `group-{chat_id}` | `group--1001234567890` |
| Forum topic | `group-{chat_id}-topic-{topic_id}` | `group--1001234567890-topic-276` |

## Memory Layout

```
~/.claude-orchestrator/
├── config.json              # Bot settings
├── CLAUDE.md                # Shared identity (symlinked into each session workdir)
├── .env                     # TELEGRAM_BOT_TOKEN
├── orchestrator.pid         # Running process PID
├── logs/
│   ├── orchestrator.log     # Main bot log
│   ├── launchd-stdout.log   # launchd wrapper output
│   └── sessions/            # Per-session stderr logs
│       ├── dm-12345678.log
│       └── ...
└── memory/
    ├── shared/              # Read by all sessions
    │   ├── user.md          # User profile & preferences
    │   ├── lessons.md       # Hard-won lessons & mistakes
    │   └── systems.md       # Infrastructure & services
    ├── private/             # Access-controlled per session
    │   └── tina-health.md   # Example: private health data
    └── sessions/            # Per-session isolated state
        ├── dm-12345678/
        │   ├── meta.json    # Session ID for --resume
        │   └── workdir/     # Claude Code cwd
        │       ├── CLAUDE.md → ../../CLAUDE.md (symlink)
        │       └── memory/  # Auto-memory files
        └── ...
```

## Source Files

```
src/
├── index.ts       # Entry point, CLI handling, graceful shutdown, retry logic
├── bot.ts         # Grammy bot setup, message handler, image download, streaming
├── session.ts     # Claude Code process lifecycle, stdin/stdout piping, LRU eviction
├── router.ts      # Message → session key routing (DM/group/topic)
├── memory.ts      # Session directory setup, shared/private memory, CLAUDE.md symlink
├── config.ts      # Config loading from ~/.claude-orchestrator/config.json
├── channel-log.ts # Per-session message logging to text files
├── types.ts       # TypeScript interfaces
└── utils.ts       # Message chunking, formatting, logger
```

## Process Management

### launchd (recommended for production)

The `start-tmux.sh` wrapper starts the orchestrator inside a tmux session and monitors it. If the tmux session dies, the wrapper exits non-zero, triggering launchd to restart.

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.oraion.claude-orchestrator.plist

# Stop
launchctl stop com.oraion.claude-orchestrator

# Restart
launchctl stop com.oraion.claude-orchestrator && sleep 3 && launchctl start com.oraion.claude-orchestrator

# Inspect live
tmux attach -t orchestrator
```

### Why tmux?

Claude Code sessions need a TTY for proper operation. The orchestrator runs inside a tmux session so each spawned Claude Code process has access to a pseudo-terminal.

## License

Private — not for redistribution.
