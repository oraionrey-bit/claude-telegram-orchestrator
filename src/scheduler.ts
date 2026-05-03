// ── Scheduled message system ──

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Bot } from "grammy";
import type { ScheduleJob } from "./types";
import { Logger } from "./utils";
import type { SessionManager } from "./session";
import type { NotificationQueue } from "./notify";

const SCHEDULES_PATH = join(process.env.HOME ?? "~", ".claude-orchestrator", "schedules.json");
const TIMEZONE = "America/Los_Angeles";

/**
 * Parse a 5-field cron expression and check if it matches a given date.
 * Fields: minute hour dom month dow
 * Supports: *, specific numbers, ranges (1-5), lists (1,3,5), steps (star/15)
 */
function parseCronField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr);
      let start = min;
      let end = max;
      if (range !== "*") {
        if (range.includes("-")) {
          [start, end] = range.split("-").map(Number);
        } else {
          start = parseInt(range);
        }
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      values.add(parseInt(part));
    }
  }

  return [...values];
}

function cronMatches(cron: string, date: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minField, hourField, domField, monthField, dowField] = fields;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const dow = date.getDay(); // 0 = Sunday

  return (
    parseCronField(minField, 0, 59).includes(minute) &&
    parseCronField(hourField, 0, 23).includes(hour) &&
    parseCronField(domField, 1, 31).includes(dom) &&
    parseCronField(monthField, 1, 12).includes(month) &&
    parseCronField(dowField, 0, 6).includes(dow)
  );
}

/**
 * Get the next time a cron expression will fire, for display purposes.
 * Scans forward minute by minute up to 48 hours.
 */
function getNextRun(cron: string, tz: string): Date | null {
  const now = new Date();
  // Start from the next minute
  const check = new Date(now.getTime() + 60_000);
  check.setSeconds(0, 0);

  for (let i = 0; i < 48 * 60; i++) {
    const localized = new Date(check.toLocaleString("en-US", { timeZone: tz }));
    // We need to construct a Date whose getHours/getMinutes etc. reflect the tz.
    // toLocaleString gives us the local representation, parse it back.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(check);

    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? "0");
    const tzDate = new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));

    if (cronMatches(cron, tzDate)) {
      return check; // Return the actual UTC-ish Date for display
    }

    check.setTime(check.getTime() + 60_000);
  }

  return null;
}

export class Scheduler {
  private bot: Bot;
  private sessionManager: SessionManager;
  private logger: Logger;
  private notifyQueue: NotificationQueue;
  private jobs: ScheduleJob[] = [];
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(bot: Bot, sessionManager: SessionManager, logger: Logger, notifyQueue: NotificationQueue) {
    this.bot = bot;
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.notifyQueue = notifyQueue;
    this.loadJobs();
  }

  /** Load jobs from schedules.json */
  private loadJobs(): void {
    try {
      if (existsSync(SCHEDULES_PATH)) {
        const raw = readFileSync(SCHEDULES_PATH, "utf-8");
        this.jobs = JSON.parse(raw) as ScheduleJob[];
        this.logger.info(`[scheduler] Loaded ${this.jobs.length} jobs from ${SCHEDULES_PATH}`);
      } else {
        this.jobs = [];
        this.logger.info("[scheduler] No schedules.json found, starting with empty schedule");
      }
    } catch (err) {
      this.logger.error(`[scheduler] Failed to load schedules: ${err}`);
      this.jobs = [];
    }
  }

  /** Save jobs to schedules.json */
  private saveJobs(): void {
    try {
      writeFileSync(SCHEDULES_PATH, JSON.stringify(this.jobs, null, 2), "utf-8");
    } catch (err) {
      this.logger.error(`[scheduler] Failed to save schedules: ${err}`);
    }
  }

  /** Start the tick loop (checks every 60 seconds) */
  start(): void {
    if (this.tickInterval) return;

    this.logger.info("[scheduler] Started");

    // Align to the start of the next minute for consistent firing
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    setTimeout(() => {
      this.tick();
      this.tickInterval = setInterval(() => this.tick(), 60_000);
    }, msUntilNextMinute);
  }

  /** Stop the tick loop */
  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      this.logger.info("[scheduler] Stopped");
    }
  }

  /** Check all jobs and fire any that are due */
  private async tick(): Promise<void> {
    // Get current time in LA timezone
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? "0");
    const laDate = new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));

    for (const job of this.jobs) {
      if (!job.enabled) continue;

      if (cronMatches(job.cron, laDate)) {
        this.logger.info(`[scheduler] Firing job "${job.name}" (${job.id}) → chat ${job.chatId}`);

        if (job.prompt) {
          // Briefing job — run prompt through Claude. Fire-and-forget so a
          // slow Claude call doesn't block other jobs scheduled in the same minute.
          this.runBriefing(job).catch((err) => {
            this.logger.error(`[scheduler] Briefing "${job.id}" failed: ${err}`);
          });
        } else {
          // Static-message job — send via notification queue.
          await this.notifyQueue.send({
            chatId: job.chatId,
            threadId: job.topicId,
            text: job.message,
            tag: `schedule:${job.id}`,
          });
          this.logger.info(`[scheduler] Job "${job.id}" sent at ${laDate.toISOString()}`);
        }
      }
    }
  }

  /**
   * Run a briefing job: spawn an isolated Claude session, send the prompt,
   * then deliver the response to the target chat in chunks.
   */
  private async runBriefing(job: ScheduleJob): Promise<void> {
    const sessionKey = `brief-${job.id}`;

    this.logger.info(`[scheduler] Briefing "${job.id}" → spawning session ${sessionKey}`);
    const startedAt = Date.now();

    let response: string;
    try {
      response = await this.sessionManager.sendMessage(
        sessionKey,
        [{ type: "text", text: job.prompt! }]
      );
    } catch (err) {
      this.logger.error(`[scheduler] Briefing "${job.id}" Claude call failed: ${err}`);
      await this.notifyQueue.send({
        chatId: job.chatId,
        threadId: job.topicId,
        text: `⚠️ Scheduled briefing "${job.name}" failed to run.`,
        tag: `briefing-error:${job.id}`,
      });
      return;
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    const text = response?.trim();
    if (!text) {
      this.logger.warn(`[scheduler] Briefing "${job.id}" returned empty response (${elapsedSec}s)`);
      return;
    }

    await this.notifyQueue.send({
      chatId: job.chatId,
      threadId: job.topicId,
      text,
      tag: `briefing:${job.id}`,
    });
    this.logger.info(`[scheduler] Briefing "${job.id}" delivered in ${elapsedSec}s`);
  }

  /** Add a new job */
  addJob(job: ScheduleJob): void {
    // Remove existing job with same id
    this.jobs = this.jobs.filter(j => j.id !== job.id);
    this.jobs.push(job);
    this.saveJobs();
    this.logger.info(`[scheduler] Added job "${job.id}"`);
  }

  /** Remove a job by id */
  removeJob(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter(j => j.id !== id);
    if (this.jobs.length < before) {
      this.saveJobs();
      this.logger.info(`[scheduler] Removed job "${id}"`);
      return true;
    }
    return false;
  }

  /** Toggle a job's enabled state */
  toggleJob(id: string): ScheduleJob | null {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return null;
    job.enabled = !job.enabled;
    this.saveJobs();
    this.logger.info(`[scheduler] Job "${id}" ${job.enabled ? "enabled" : "disabled"}`);
    return job;
  }

  /** List all jobs with next run time */
  listJobs(): Array<ScheduleJob & { nextRun: string | null }> {
    return this.jobs.map(job => {
      const next = job.enabled ? getNextRun(job.cron, TIMEZONE) : null;
      return {
        ...job,
        nextRun: next
          ? next.toLocaleString("en-US", { timeZone: TIMEZONE, dateStyle: "short", timeStyle: "short" })
          : null,
      };
    });
  }

  /** Reload jobs from disk (useful if file was edited manually) */
  reload(): void {
    this.loadJobs();
  }
}
