const { runDueTasks } = require('../v2/services/taskScheduler');
const { runDailyClassReminderJob } = require('./jobs/dailyClassReminderJob');

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

function matchField(spec, value) {
  if (!spec) return false;
  if (spec.type === 'any') return true;
  if (spec.type === 'value') return spec.value === value;
  if (spec.type === 'step') return value % spec.step === 0;
  return false;
}

function shouldRunNow(cronExpr, now = new Date()) {
  const parts = String(cronExpr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const specs = [
    parseField(parts[0], 0, 59),
    parseField(parts[1], 0, 23),
    parseField(parts[2], 1, 31),
    parseField(parts[3], 1, 12),
    parseField(parts[4], 0, 6)
  ];
  if (!specs.every(Boolean)) return false;

  return (
    matchField(specs[0], now.getMinutes()) &&
    matchField(specs[1], now.getHours()) &&
    matchField(specs[2], now.getDate()) &&
    matchField(specs[3], now.getMonth() + 1) &&
    matchField(specs[4], now.getDay())
  );
}

let timer = null;
let started = false;
let minuteLock = '';

function startWorkerScheduler(context = console) {
  if (started) return;
  started = true;

  const reminderCron = String(process.env.ARIS_REMINDER_CRON || '0 7 * * *');
  const intervalMs = Number(process.env.ARIS_WORKER_POLL_MS || 30000);

  timer = setInterval(async () => {
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (minuteLock === minuteKey) return;
    minuteLock = minuteKey;

    try {
      await runDueTasks(context);
    } catch (err) {
      context?.error?.(`[worker] runDueTasks failed: ${err.message}`);
    }

    if (shouldRunNow(reminderCron, now)) {
      try {
        await runDailyClassReminderJob(context);
      } catch (err) {
        context?.error?.(`[worker] daily reminder failed: ${err.message}`);
      }
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  context?.log?.(`[worker] scheduler started poll_ms=${intervalMs} reminder_cron=${reminderCron}`);
}

function stopWorkerScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = {
  startWorkerScheduler,
  stopWorkerScheduler,
  shouldRunNow
};
