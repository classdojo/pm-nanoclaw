import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import path from 'path';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import { readEnvFile } from './env.js';

// ── Cost Tracking ───────────────────────────────────────────────────────────

const COST_FILE = path.join(process.cwd(), 'store', 'cost-tracker.json');

interface CostEntry {
  date: string; // YYYY-MM-DD
  group: string;
  runs: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface CostTracker {
  entries: CostEntry[];
  dailyBudgetUsd: number; // 0 = unlimited
}

function loadCostTracker(): CostTracker {
  try {
    return JSON.parse(fs.readFileSync(COST_FILE, 'utf-8'));
  } catch {
    return { entries: [], dailyBudgetUsd: 5.0 };
  }
}

function saveCostTracker(tracker: CostTracker): void {
  fs.writeFileSync(COST_FILE, JSON.stringify(tracker, null, 2));
}

export function trackCost(
  group: string,
  costUsd?: number,
  usage?: { input_tokens?: number; output_tokens?: number },
): void {
  const tracker = loadCostTracker();
  const today = new Date().toISOString().slice(0, 10);
  let entry = tracker.entries.find((e) => e.date === today && e.group === group);
  if (!entry) {
    entry = { date: today, group, runs: 0, totalCostUsd: 0, inputTokens: 0, outputTokens: 0 };
    tracker.entries.push(entry);
  }
  entry.runs++;
  if (costUsd) entry.totalCostUsd += costUsd;
  if (usage?.input_tokens) entry.inputTokens += usage.input_tokens;
  if (usage?.output_tokens) entry.outputTokens += usage.output_tokens;

  // Prune entries older than 30 days
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  tracker.entries = tracker.entries.filter((e) => e.date >= cutoff);

  saveCostTracker(tracker);
}

export function isDailyBudgetExceeded(group: string): boolean {
  const tracker = loadCostTracker();
  if (tracker.dailyBudgetUsd <= 0) return false;
  const today = new Date().toISOString().slice(0, 10);
  const todayCost = tracker.entries
    .filter((e) => e.date === today && e.group === group)
    .reduce((sum, e) => sum + e.totalCostUsd, 0);
  if (todayCost >= tracker.dailyBudgetUsd) {
    logger.warn(
      { group, todayCost, budget: tracker.dailyBudgetUsd },
      'Daily budget exceeded — skipping scheduled task',
    );
    return true;
  }
  return false;
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  // Check daily budget before running
  if (isDailyBudgetExceeded(task.group_folder)) {
    const nextRun = computeNextRun(task);
    updateTaskAfterRun(task.id, nextRun, 'Skipped: daily budget exceeded');
    return;
  }

  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        allowedTools: group.containerConfig?.allowedTools,
        additionalMcpServers: group.containerConfig?.additionalMcpServers,
        model: group.containerConfig?.model,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    // Track cost if reported by the agent
    if (output.totalCostUsd != null || output.usage) {
      trackCost(task.group_folder, output.totalCostUsd, output.usage);
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime, cost: output.totalCostUsd },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  const runAt = new Date().toISOString();
  logTaskRun({
    task_id: task.id,
    run_at: runAt,
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  // Write a human-readable log file for the group
  try {
    const logDir = path.join(resolveGroupFolderPath(task.group_folder), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'scan-history.log');
    const entry = `[${runAt}] ${error ? 'ERROR' : 'OK'} (${Math.round(durationMs / 1000)}s)${result ? '\n' + result.slice(0, 500) : error ? '\n' + error : ''}\n---\n`;
    fs.appendFileSync(logFile, entry);
    // Rotate: keep last 5GB
    const stat = fs.statSync(logFile);
    if (stat.size > 5_000_000_000) {
      const content = fs.readFileSync(logFile, 'utf-8');
      fs.writeFileSync(logFile, content.slice(-4_000_000_000));
    }
  } catch {
    // Non-critical, don't crash
  }

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
