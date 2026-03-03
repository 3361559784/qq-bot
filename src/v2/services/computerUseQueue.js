const { generateId, nowIso } = require('../utils');
const { listDocs, readDoc, upsertDoc } = require('./storage');

const JOB_PARTITION_KEY = 'computer_use_jobs:global';

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  LEASED: 'leased',
  RUNNING: 'running',
  WAITING_CONFIRMATION: 'waiting_confirmation',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function isTerminalStatus(status) {
  return status === JOB_STATUS.COMPLETED
    || status === JOB_STATUS.FAILED
    || status === JOB_STATUS.CANCELLED;
}

function isLeaseExpired(lease = null) {
  if (!lease || !lease.lease_until) return true;
  const ts = Date.parse(String(lease.lease_until));
  if (!Number.isFinite(ts)) return true;
  return Date.now() >= ts;
}

function makeLease(agentId, leaseTtlSec) {
  const ttl = clampInt(leaseTtlSec, 5, 300, 45);
  return {
    agent_id: String(agentId || 'unknown'),
    lease_token: generateId('lease'),
    leased_at: nowIso(),
    lease_until: new Date(Date.now() + ttl * 1000).toISOString(),
    heartbeat_at: nowIso()
  };
}

function sortByCreatedAtAsc(a, b) {
  const x = Date.parse(String(a?.created_at || ''));
  const y = Date.parse(String(b?.created_at || ''));
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

async function createComputerUseJob(payload = {}, context = null) {
  const job = {
    id: generateId('cujob'),
    request_id: String(payload.request_id || ''),
    user_id: String(payload.user_id || 'unknown'),
    context_id: String(payload.context_id || ''),
    objective: String(payload.objective || '').trim(),
    trigger: String(payload.trigger || 'api'),
    status: JOB_STATUS.QUEUED,
    confirm_mode: String(payload.confirm_mode || 'periodic'),
    confirm_every_steps: clampInt(payload.confirm_every_steps, 1, 50, 5),
    step_max_retry: clampInt(payload.step_max_retry, 0, 10, 2),
    max_steps: clampInt(payload.max_steps, 1, 200, 30),
    steps_executed: 0,
    confirm_round: 0,
    steps: [],
    lease: null,
    output: null,
    error: null,
    summary: '',
    last_screenshot_ref: '',
    transport: String(payload.transport || 'http_agent'),
    provider: String(payload.provider || 'unknown'),
    provider_attempts: clampInt(payload.provider_attempts, 0, 1000, 0),
    provider_error_chain: Array.isArray(payload.provider_error_chain) ? payload.provider_error_chain.slice(0, 20) : [],
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    created_at: nowIso(),
    updated_at: nowIso(),
    partitionKey: JOB_PARTITION_KEY
  };

  await upsertDoc('computerUseJobs', JOB_PARTITION_KEY, job, context);
  return job;
}

async function getComputerUseJob(jobId, context = null) {
  return readDoc('computerUseJobs', String(jobId || ''), JOB_PARTITION_KEY, context);
}

async function listComputerUseJobs(limit = 200, context = null) {
  return listDocs('computerUseJobs', JOB_PARTITION_KEY, {
    limit: clampInt(limit, 1, 1000, 200)
  }, context);
}

async function updateComputerUseJob(jobId, mutator, context = null) {
  const current = await getComputerUseJob(jobId, context);
  if (!current) return null;

  const next = mutator ? mutator({ ...current }) : { ...current };
  if (!next) return null;

  next.updated_at = nowIso();
  next.partitionKey = JOB_PARTITION_KEY;
  await upsertDoc('computerUseJobs', JOB_PARTITION_KEY, next, context);
  return next;
}

async function leaseNextComputerUseJob({ agentId, leaseTtlSec = 45 } = {}, context = null) {
  const items = await listComputerUseJobs(300, context);
  const jobs = Array.isArray(items) ? items.slice().sort(sortByCreatedAtAsc) : [];

  for (const job of jobs) {
    if (isTerminalStatus(job.status)) continue;
    if (job.status === JOB_STATUS.WAITING_CONFIRMATION) continue;

    const leasedAndAlive = (job.status === JOB_STATUS.LEASED || job.status === JOB_STATUS.RUNNING) && !isLeaseExpired(job.lease);
    if (leasedAndAlive) continue;

    const nextStatus = job.status === JOB_STATUS.RUNNING ? JOB_STATUS.RUNNING : JOB_STATUS.LEASED;
    const leased = {
      ...job,
      status: nextStatus,
      lease: makeLease(agentId, leaseTtlSec),
      error: null
    };

    await upsertDoc('computerUseJobs', JOB_PARTITION_KEY, {
      ...leased,
      updated_at: nowIso(),
      partitionKey: JOB_PARTITION_KEY
    }, context);
    return leased;
  }

  return null;
}

function normalizeStep(step = {}, fallbackIndex = 0) {
  return {
    index: clampInt(step.index, 0, 10000, fallbackIndex),
    action: String(step.action || '').trim(),
    status: String(step.status || 'success').toLowerCase(),
    duration_ms: clampInt(step.duration_ms, 0, 3600000, 0),
    retry_count: clampInt(step.retry_count, 0, 20, 0),
    error: step.error ? String(step.error) : null,
    screenshot_ref: step.screenshot_ref ? String(step.screenshot_ref) : '',
    output: step.output ?? null,
    created_at: nowIso()
  };
}

async function reportComputerUseProgress(report = {}, context = null) {
  const jobId = String(report.job_id || '');
  const job = await getComputerUseJob(jobId, context);
  if (!job) {
    return { ok: false, error: 'job_not_found' };
  }
  if (isTerminalStatus(job.status)) {
    return { ok: false, error: 'job_already_closed', job };
  }

  const reportType = String(report.report_type || 'step').toLowerCase();
  const fromAgentId = String(report.agent_id || '');
  const leaseToken = String(report.lease_token || '');

  const lease = job.lease || null;
  if (reportType !== 'final' && reportType !== 'cancelled_by_user') {
    if (!lease || isLeaseExpired(lease)) return { ok: false, error: 'lease_expired', job };
    if (fromAgentId && lease.agent_id !== fromAgentId) return { ok: false, error: 'lease_agent_mismatch', job };
    if (!leaseToken || lease.lease_token !== leaseToken) return { ok: false, error: 'lease_token_invalid', job };
  }

  const updated = { ...job };
  updated.updated_at = nowIso();

  if (reportType === 'heartbeat') {
    updated.lease = {
      ...lease,
      heartbeat_at: nowIso()
    };
    await upsertDoc('computerUseJobs', JOB_PARTITION_KEY, {
      ...updated,
      partitionKey: JOB_PARTITION_KEY
    }, context);
    return { ok: true, job: updated };
  }

  if (reportType === 'final') {
    const result = report.result && typeof report.result === 'object' ? report.result : {};
    const success = result.success !== false;
    updated.status = success ? JOB_STATUS.COMPLETED : JOB_STATUS.FAILED;
    updated.summary = String(result.summary || updated.summary || '').trim();
    updated.output = result.output ?? updated.output ?? null;
    updated.error = success ? null : String(result.error || report.error || updated.error || 'execution_failed');
    updated.last_screenshot_ref = String(result.last_screenshot_ref || updated.last_screenshot_ref || '');
    updated.transport = String(result.transport || updated.transport || 'http_agent');
    updated.provider = String(result.provider || updated.provider || 'unknown');
    updated.provider_attempts = clampInt(
      Number(result.provider_attempts ?? updated.provider_attempts ?? 0),
      0,
      1000,
      0
    );
    updated.provider_error_chain = Array.isArray(result.provider_error_chain)
      ? result.provider_error_chain.slice(0, 20)
      : (Array.isArray(updated.provider_error_chain) ? updated.provider_error_chain : []);
    updated.lease = null;

    await upsertDoc('computerUseJobs', JOB_PARTITION_KEY, {
      ...updated,
      partitionKey: JOB_PARTITION_KEY
    }, context);
    return { ok: true, job: updated };
  }

  const step = normalizeStep(report.step || {}, Array.isArray(updated.steps) ? updated.steps.length : 0);
  if (!Array.isArray(updated.steps)) updated.steps = [];
  updated.steps.push(step);

  if (step.screenshot_ref) {
    updated.last_screenshot_ref = step.screenshot_ref;
  }

  if (step.status === 'success') {
    updated.steps_executed = clampInt(Number(updated.steps_executed || 0) + 1, 0, 100000, 0);
    const confirmMode = String(updated.confirm_mode || 'periodic').toLowerCase();
    const confirmEvery = clampInt(updated.confirm_every_steps, 1, 50, 5);
    const shouldConfirm = confirmMode === 'always'
      || (confirmMode === 'periodic' && updated.steps_executed > 0 && updated.steps_executed % confirmEvery === 0);

    if (shouldConfirm && updated.steps_executed < clampInt(updated.max_steps, 1, 200, 30)) {
      updated.status = JOB_STATUS.WAITING_CONFIRMATION;
      updated.confirm_round = clampInt(Number(updated.confirm_round || 0) + 1, 0, 9999, 0);
      updated.lease = null;
    } else {
      updated.status = JOB_STATUS.RUNNING;
    }
  } else {
    const retry = clampInt(step.retry_count, 0, 20, 0);
    const maxRetry = clampInt(updated.step_max_retry, 0, 10, 2);
    if (retry >= maxRetry) {
      updated.status = JOB_STATUS.FAILED;
      updated.error = step.error || 'step_retry_exhausted';
      updated.lease = null;
    } else {
      updated.status = JOB_STATUS.RUNNING;
    }
  }

  await upsertDoc('computerUseJobs', JOB_PARTITION_KEY, {
    ...updated,
    partitionKey: JOB_PARTITION_KEY
  }, context);
  return { ok: true, job: updated };
}

async function confirmComputerUseJob(jobId, context = null) {
  return updateComputerUseJob(jobId, (job) => {
    if (job.status !== JOB_STATUS.WAITING_CONFIRMATION) return job;
    return {
      ...job,
      status: JOB_STATUS.QUEUED,
      error: null
    };
  }, context);
}

async function cancelComputerUseJob(jobId, reason = 'cancelled', context = null) {
  return updateComputerUseJob(jobId, (job) => {
    if (isTerminalStatus(job.status)) return job;
    return {
      ...job,
      status: JOB_STATUS.CANCELLED,
      error: String(reason || 'cancelled'),
      lease: null
    };
  }, context);
}

async function waitForComputerUseJob(jobId, timeoutMs = 18000, pollMs = 500, context = null) {
  const end = Date.now() + clampInt(timeoutMs, 1000, 180000, 18000);
  const interval = clampInt(pollMs, 100, 5000, 500);

  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    const job = await getComputerUseJob(jobId, context);
    if (!job) return null;
    if (isTerminalStatus(job.status) || job.status === JOB_STATUS.WAITING_CONFIRMATION) return job;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  return getComputerUseJob(jobId, context);
}

async function setComputerUseJobState(jobId, patch = {}, context = null) {
  return updateComputerUseJob(jobId, (job) => {
    const next = { ...job };
    if (patch.status) next.status = String(patch.status);
    if (Object.prototype.hasOwnProperty.call(patch, 'summary')) next.summary = String(patch.summary || '');
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) {
      next.error = patch.error ? String(patch.error) : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'output')) next.output = patch.output ?? null;
    if (Object.prototype.hasOwnProperty.call(patch, 'steps_executed')) {
      next.steps_executed = clampInt(patch.steps_executed, 0, 100000, Number(job.steps_executed || 0));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'confirm_round')) {
      next.confirm_round = clampInt(patch.confirm_round, 0, 9999, Number(job.confirm_round || 0));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'last_screenshot_ref')) {
      next.last_screenshot_ref = String(patch.last_screenshot_ref || '');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'transport')) {
      next.transport = String(patch.transport || next.transport || 'http_agent');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'provider')) {
      next.provider = String(patch.provider || next.provider || 'unknown');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'provider_attempts')) {
      next.provider_attempts = clampInt(
        patch.provider_attempts,
        0,
        1000,
        Number(next.provider_attempts || 0)
      );
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'provider_error_chain')) {
      next.provider_error_chain = Array.isArray(patch.provider_error_chain)
        ? patch.provider_error_chain.slice(0, 20)
        : [];
    }
    if (Array.isArray(patch.steps)) {
      next.steps = patch.steps.slice(0, 200);
    }
    if (isTerminalStatus(next.status) || next.status === JOB_STATUS.WAITING_CONFIRMATION) {
      next.lease = null;
    }
    return next;
  }, context);
}

function sanitizeJobForAgent(job = {}) {
  return {
    id: job.id,
    request_id: job.request_id,
    user_id: job.user_id,
    context_id: job.context_id,
    objective: job.objective,
    trigger: job.trigger,
    status: job.status,
    max_steps: job.max_steps,
    step_max_retry: job.step_max_retry,
    confirm_mode: job.confirm_mode,
    confirm_every_steps: job.confirm_every_steps,
    steps_executed: job.steps_executed || 0,
    confirm_round: job.confirm_round || 0,
    lease: job.lease,
    metadata: job.metadata || {},
    transport: job.transport || 'http_agent',
    provider: job.provider || 'unknown',
    provider_attempts: Number(job.provider_attempts || 0),
    provider_error_chain: Array.isArray(job.provider_error_chain) ? job.provider_error_chain : []
  };
}

module.exports = {
  JOB_PARTITION_KEY,
  JOB_STATUS,
  isTerminalStatus,
  createComputerUseJob,
  getComputerUseJob,
  listComputerUseJobs,
  leaseNextComputerUseJob,
  reportComputerUseProgress,
  confirmComputerUseJob,
  cancelComputerUseJob,
  waitForComputerUseJob,
  setComputerUseJobState,
  sanitizeJobForAgent
};
