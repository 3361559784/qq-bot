const { generateId, nowIso } = require('../utils');
const { V2_DEFAULTS } = require('../constants');
const { upsertDoc, listDocs, readDoc, deleteDoc } = require('./storage');
const { executeSkill } = require('./skillRuntime');
const { logAudit } = require('./auditService');

let schedulerTimer = null;
let schedulerStarted = false;

function parseField(expr, min, max) {
  const token = String(expr || '').trim();
  if (token === '*') return { type: 'any' };
  if (/^\*\/(\d+)$/.test(token)) {
    const step = Number(token.match(/^\*\/(\d+)$/)[1]);
    return { type: 'step', step };
  }
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    if (value < min || value > max) return null;
    return { type: 'value', value };
  }
  return null;
}

function isCronValid(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const specs = [
    parseField(parts[0], 0, 59),
    parseField(parts[1], 0, 23),
    parseField(parts[2], 1, 31),
    parseField(parts[3], 1, 12),
    parseField(parts[4], 0, 6)
  ];

  return specs.every(Boolean);
}

function matchField(spec, value) {
  if (!spec) return false;
  if (spec.type === 'any') return true;
  if (spec.type === 'value') return spec.value === value;
  if (spec.type === 'step') return value % spec.step === 0;
  return false;
}

function shouldRunNow(cron, nowDate) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const specs = [
    parseField(parts[0], 0, 59),
    parseField(parts[1], 0, 23),
    parseField(parts[2], 1, 31),
    parseField(parts[3], 1, 12),
    parseField(parts[4], 0, 6)
  ];
  if (!specs.every(Boolean)) return false;

  const d = nowDate;
  return (
    matchField(specs[0], d.getUTCMinutes()) &&
    matchField(specs[1], d.getUTCHours()) &&
    matchField(specs[2], d.getUTCDate()) &&
    matchField(specs[3], d.getUTCMonth() + 1) &&
    matchField(specs[4], d.getUTCDay())
  );
}

async function createTask(payload, context = null) {
  const cron = String(payload.cron || '').trim();
  const skill = String(payload.skill || '').trim();

  if (!isCronValid(cron)) throw new Error('invalid cron expression');
  if (!skill) throw new Error('skill is required');

  const task = {
    id: generateId('task'),
    name: String(payload.name || skill),
    cron,
    skill,
    payload: payload.payload || {},
    timezone: payload.timezone || 'Asia/Shanghai',
    retry_policy: payload.retry_policy || { max_retry: V2_DEFAULTS.scheduler.maxRetry },
    status: payload.status || 'active',
    last_run_at: null,
    next_run_hint: null,
    run_count: 0,
    fail_count: 0,
    last_error: null,
    created_at: nowIso(),
    updated_at: nowIso()
  };

  await upsertDoc('tasks', 'tasks:global', task, context);
  return task;
}

async function listTasks(context = null) {
  return listDocs('tasks', 'tasks:global', { limit: 1000 }, context);
}

async function patchTask(id, patch, context = null) {
  const task = await readDoc('tasks', id, 'tasks:global', context);
  if (!task) throw new Error('task not found');

  if (patch.cron && !isCronValid(patch.cron)) throw new Error('invalid cron expression');

  const next = {
    ...task,
    ...patch,
    id: task.id,
    updated_at: nowIso()
  };

  await upsertDoc('tasks', 'tasks:global', next, context);
  return next;
}

async function removeTask(id, context = null) {
  return deleteDoc('tasks', id, 'tasks:global', context);
}

async function runDueTasks(context = null) {
  const tasks = await listTasks(context);
  const now = new Date();
  const minuteKey = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;

  for (const task of tasks) {
    if (task.status !== 'active') continue;
    if (!shouldRunNow(task.cron, now)) continue;
    if (task.last_run_minute === minuteKey) continue;

    const started = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      const call = await executeSkill(task.skill, task.payload || {}, context);
      const success = call.status === 'success';

      const updated = {
        ...task,
        last_run_at: nowIso(),
        last_run_minute: minuteKey,
        run_count: Number(task.run_count || 0) + 1,
        fail_count: success ? Number(task.fail_count || 0) : Number(task.fail_count || 0) + 1,
        last_error: success ? null : call.error,
        updated_at: nowIso()
      };

      // eslint-disable-next-line no-await-in-loop
      await upsertDoc('tasks', 'tasks:global', updated, context);
      // eslint-disable-next-line no-await-in-loop
      await logAudit('task.executed', {
        task_id: task.id,
        skill: task.skill,
        success,
        duration_ms: Date.now() - started,
        error: success ? null : call.error
      }, context);
    } catch (err) {
      const updated = {
        ...task,
        last_run_at: nowIso(),
        last_run_minute: minuteKey,
        run_count: Number(task.run_count || 0) + 1,
        fail_count: Number(task.fail_count || 0) + 1,
        last_error: err.message,
        updated_at: nowIso()
      };

      // eslint-disable-next-line no-await-in-loop
      await upsertDoc('tasks', 'tasks:global', updated, context);
      // eslint-disable-next-line no-await-in-loop
      await logAudit('task.failed', {
        task_id: task.id,
        skill: task.skill,
        success: false,
        duration_ms: Date.now() - started,
        error: err.message
      }, context);
    }
  }
}

function startScheduler(context = null) {
  if (schedulerStarted) return;
  schedulerStarted = true;
  schedulerTimer = setInterval(() => {
    runDueTasks(context).catch((err) => {
      context?.log?.(`[v2/scheduler] runDueTasks failed: ${err.message}`);
    });
  }, V2_DEFAULTS.scheduler.pollMs);
  if (schedulerTimer && typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}

function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
  schedulerStarted = false;
}

module.exports = {
  isCronValid,
  createTask,
  listTasks,
  patchTask,
  removeTask,
  runDueTasks,
  startScheduler,
  stopScheduler
};
