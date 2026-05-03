// ── Entry point & CLI handling ──

import { join } from "path";
import { loadConfig, getBotToken, getConfigDir } from "./config";
import { SessionManager } from "./session";
import { createBot, setScheduler } from "./bot";
import { initMemory } from "./memory";
import { initChannelLogs } from "./channel-log";
import { Scheduler } from "./scheduler";
import { NotificationQueue } from "./notify";
import { loadUserConfigs } from "./user-config";
import { loadInflight, clearInflight } from "./inflight";
import { startHttpServer } from "./http-server";
import { Logger } from "./utils";

const LOGS_DIR = join(getConfigDir(), "logs");

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // CLI: --status
  if (args.includes("--status")) {
    await showStatus();
    return;
  }

  // CLI: --stop
  if (args.includes("--stop")) {
    await stopOrchestrator();
    return;
  }

  // Default: start orchestrator
  await startOrchestrator();
}

async function startOrchestrator(): Promise<void> {
  const logger = new Logger(join(LOGS_DIR, "orchestrator.log"));
  logger.info("Starting Claude Telegram Orchestrator...");

  // Load config
  const config = loadConfig();
  logger.info(`Config loaded: ${config.allowedUsers.length} allowed users, max ${config.maxSessions} sessions`);

  // Initialize memory structure and user configs
  initMemory();
  initChannelLogs();
  loadUserConfigs();
  logger.info("Memory, channel logs, and user configs initialized");

  // Get bot token
  let token: string;
  try {
    token = getBotToken();
  } catch (err) {
    logger.error(`${err}`);
    process.exit(1);
  }

  // Create notification queue
  const notifyQueue = new NotificationQueue(logger);

  // Create session manager
  const sessionManager = new SessionManager(config, logger);
  sessionManager.startIdleChecker();

  // Create and start bot
  const bot = createBot(token, config, sessionManager, logger, notifyQueue);

  // Wire API into notification queue and start it
  notifyQueue.setApi(bot.api);
  notifyQueue.start();

  // Create and start scheduler
  const scheduler = new Scheduler(bot, sessionManager, logger, notifyQueue);
  setScheduler(scheduler);
  scheduler.start();

  // Start HTTP server (for programmatic access via Cloudflare tunnel)
  const httpServer = startHttpServer(sessionManager, logger);

  // Write PID file for --stop command
  const pidPath = join(getConfigDir(), "orchestrator.pid");
  await Bun.write(pidPath, process.pid.toString());

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    notifyQueue.stop();
    scheduler.stop();
    httpServer.stop();
    try {
      bot.stop();
    } catch {
      // Already stopped
    }
    await sessionManager.killAll();

    // Remove PID file
    try {
      const { unlinkSync } = await import("fs");
      unlinkSync(pidPath);
    } catch {
      // ignore
    }

    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Start the bot with retry logic for 409 conflicts
  logger.info("Bot starting...");

  // Force-kill any competing orchestrator process (stale polling instance causing 409s)
  const forceKillCompetingProcesses = async () => {
    const { execSync } = await import("child_process");
    const myPid = process.pid;
    let killedAny = false;

    // 1. Kill process from PID file if it's not us
    const pidFilePath = join(getConfigDir(), "orchestrator.pid");
    try {
      const pidFile = Bun.file(pidFilePath);
      if (await pidFile.exists()) {
        const pid = parseInt(await pidFile.text());
        if (pid && pid !== myPid && !isNaN(pid)) {
          try {
            process.kill(pid, 0); // Check if alive
            logger.warn(`[bot] Force-killing stale orchestrator PID ${pid} (SIGKILL)`);
            process.kill(pid, "SIGKILL");
            killedAny = true;
          } catch {
            // Already dead
          }
        }
      }
    } catch {
      // PID file doesn't exist or unreadable
    }

    // 2. Kill any bun processes running this orchestrator (narrow patterns to avoid killing the launchd wrapper)
    const patterns = [
      "claude-telegram-orchestrator/src/index",
      "bun.*src/index.ts",
    ];
    for (const pattern of patterns) {
      try {
        const result = execSync(`pgrep -f "${pattern}" 2>/dev/null || true`).toString().trim();
        if (result) {
          for (const line of result.split("\n")) {
            const pid = parseInt(line.trim());
            if (pid && pid !== myPid && !isNaN(pid)) {
              try {
                process.kill(pid, 0); // Verify it exists
                logger.warn(`[bot] Killing competing process PID ${pid} (pattern: ${pattern})`);
                process.kill(pid, "SIGKILL");
                killedAny = true;
              } catch {
                // Already dead
              }
            }
          }
        }
      } catch {
        // pgrep not available or failed
      }
    }

    // 3. Also kill child processes of any killed PIDs (zombie prevention)
    if (killedAny) {
      try {
        // Give processes a moment to die, then check for orphaned children
        await new Promise(r => setTimeout(r, 500));
        const orphans = execSync(`pgrep -P 1 -f "grammy\\|telegram-orchestrator" 2>/dev/null || true`).toString().trim();
        if (orphans) {
          for (const line of orphans.split("\n")) {
            const pid = parseInt(line.trim());
            if (pid && pid !== myPid && !isNaN(pid)) {
              try {
                process.kill(pid, "SIGKILL");
                logger.warn(`[bot] Killed orphaned child PID ${pid}`);
              } catch { /* already dead */ }
            }
          }
        }
      } catch { /* ignore */ }

      // Wait for processes to fully die
      await new Promise(r => setTimeout(r, 1000));
    }

    return killedAny;
  };

  // Pre-startup: kill competing processes, clear webhook, release server-side lock
  logger.info("[bot] Pre-startup cleanup...");
  await forceKillCompetingProcesses();
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    logger.info("[bot] Cleared webhook and pending updates");
  } catch (err) {
    logger.warn(`[bot] Could not clear webhook: ${err}`);
  }
  try {
    await bot.api.close();
    logger.info("[bot] Released Telegram server-side polling lock");
  } catch {
    // close() may fail if no session exists — that's fine
  }
  // Wait for Telegram to fully release the polling session
  await new Promise(r => setTimeout(r, 3000));

  // Start with auto-restart on 409 crashes
  const MAX_RETRY_ATTEMPTS = 30;
  const startWithRetry = async () => {
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        await bot.start({
          drop_pending_updates: true,
          onStart: async (info) => {
            logger.info(`Bot started as @${info.username} (${info.first_name})`);

            // Recover interrupted in-flight messages
            const stale = loadInflight();
            if (stale.length > 0) {
              logger.info(`[recovery] Found ${stale.length} interrupted in-flight message(s)`);
              for (const msg of stale) {
                logger.info(`[recovery] Recovering session ${msg.sessionKey} (from ${msg.senderName})`);
                const recoveryPrompt = [{
                  type: "text" as const,
                  text: `[System: The orchestrator restarted while you were processing a message. ` +
                    `Your previous work was interrupted. The original request from ${msg.senderName} was: ` +
                    `"${msg.messageText.slice(0, 500)}". ` +
                    `Please continue where you left off and provide your response.]`,
                }];
                try {
                  const response = await sessionManager.sendMessage(msg.sessionKey, recoveryPrompt);
                  if (response?.trim()) {
                    await notifyQueue.send({
                      chatId: msg.chatId,
                      threadId: msg.threadId,
                      text: response,
                      fallbackChatId: msg.fallbackChatId,
                      fallbackThreadId: msg.fallbackThreadId,
                      tag: `recovery:${msg.sessionKey}`,
                    });
                    logger.info(`[recovery] Delivered recovered response for ${msg.sessionKey}`);
                  }
                } catch (err) {
                  logger.error(`[recovery] Failed to recover ${msg.sessionKey}: ${err}`);
                }
                clearInflight(msg.sessionKey);
              }
            }
          },
        });
        return; // Clean exit
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("409") || msg.includes("Conflict")) {
          logger.warn(`[bot] 409 Conflict (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`);

          // Step 1: Stop Grammy's internal polling loop to prevent dual-retry
          try { bot.stop(); } catch { /* already stopped */ }

          // Step 2: Force-kill any competing processes
          const killed = await forceKillCompetingProcesses();

          // Step 3: Tell Telegram to release the server-side polling lock
          try {
            await bot.api.close();
            logger.info(`[bot] Called bot.api.close() — Telegram server-side session released`);
          } catch (closeErr) {
            // close() might fail if already closed or conflicting — that's ok
            logger.debug(`[bot] bot.api.close() failed (expected): ${closeErr}`);
          }

          // Step 4: Clear webhook to be thorough
          try {
            await bot.api.deleteWebhook({ drop_pending_updates: true });
          } catch { /* ignore */ }

          // Step 5: Backoff — longer if we killed something (needs time to release)
          const baseDelay = killed ? 3000 : 2000;
          const delay = Math.min(baseDelay * attempt, 30000);
          logger.info(`[bot] Retrying in ${delay / 1000}s... (killed=${killed})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (msg.includes("Aborted")) return;
        logger.error(`[bot] Polling error: ${msg}, restarting in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    logger.error(`[bot] Failed to start after ${MAX_RETRY_ATTEMPTS} attempts — giving up`);
    process.exit(1);
  };
  
  startWithRetry().catch(err => {
    logger.error(`[bot] Fatal: ${err}`);
    process.exit(1);
  });
}

async function showStatus(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger();
  const sessionManager = new SessionManager(config, logger);

  // Check if orchestrator is running
  const pidPath = join(getConfigDir(), "orchestrator.pid");
  try {
    const pidFile = Bun.file(pidPath);
    if (await pidFile.exists()) {
      const pid = parseInt(await pidFile.text());
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Orchestrator running (PID ${pid})`);
      } catch {
        console.log("Orchestrator not running (stale PID file)");
      }
    } else {
      console.log("Orchestrator not running");
    }
  } catch {
    console.log("Orchestrator not running");
  }

  console.log(`\nConfig: ${JSON.stringify(config, null, 2)}`);

  // Show session dirs
  const { readdirSync, existsSync } = await import("fs");
  const sessionsDir = join(getConfigDir(), "memory", "sessions");
  if (existsSync(sessionsDir)) {
    const dirs = readdirSync(sessionsDir);
    console.log(`\nSession directories: ${dirs.length}`);
    for (const d of dirs) {
      console.log(`  - ${d}`);
    }
  }
}

async function stopOrchestrator(): Promise<void> {
  const pidPath = join(getConfigDir(), "orchestrator.pid");
  try {
    const pidFile = Bun.file(pidPath);
    if (await pidFile.exists()) {
      const pid = parseInt(await pidFile.text());
      process.kill(pid, "SIGTERM");
      console.log(`Sent SIGTERM to orchestrator (PID ${pid})`);
    } else {
      console.log("No PID file found — orchestrator may not be running");
    }
  } catch (err) {
    console.error(`Error stopping orchestrator: ${err}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
