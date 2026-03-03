const { logAudit } = require('./auditService');
const {
  JOB_STATUS,
  createComputerUseJob,
  getComputerUseJob,
  leaseNextComputerUseJob,
  reportComputerUseProgress,
  confirmComputerUseJob,
  cancelComputerUseJob,
  waitForComputerUseJob,
  sanitizeJobForAgent
} = require('./computerUseQueue');

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function normalizeMode(value, fallback, allow) {
  const raw = String(value || '').trim().toLowerCase();
  if (allow.includes(raw)) return raw;
  return fallback;
}

function getComputerUseRuntimeConfig(env = process.env) {
  const profile = normalizeMode(env.ARIS_RUNTIME_PROFILE, 'host', ['host', 'server']);
  return {
    profile,
    enabled: parseBool(env.ARIS_CU_ENABLED, profile === 'host'),
    triggerMode: normalizeMode(env.ARIS_CU_TRIGGER_MODE, 'both', ['explicit', 'auto', 'both']),
    confirmMode: normalizeMode(env.ARIS_CU_CONFIRM_MODE, 'periodic', ['periodic', 'always', 'never']),
    confirmEverySteps: clampInt(env.ARIS_CU_CONFIRM_EVERY_STEPS, 1, 50, 5),
    stepMaxRetry: clampInt(env.ARIS_CU_STEP_MAX_RETRY, 0, 10, 2),
    maxSteps: clampInt(env.ARIS_CU_MAX_STEPS, 1, 200, 30),
    syncWaitMs: clampInt(env.ARIS_CU_SYNC_WAIT_MS, 1000, 180000, 18000),
    leaseTtlSec: clampInt(env.ARIS_CU_LEASE_TTL_SEC, 5, 300, 45),
    remoteEndpoint: String(env.ARIS_CU_REMOTE_ENDPOINT || '').trim(),
    plannerModel: String(env.ARIS_CU_PLANNER_MODEL || 'gpt-4o-mini').trim(),
    agentToken: String(env.ARIS_CU_AGENT_TOKEN || '').trim()
  };
}

function getComputerUseAvailability(config) {
  const cfg = config || getComputerUseRuntimeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'computer_use_disabled' };
  if (cfg.profile === 'server' && !cfg.remoteEndpoint) {
    return { ok: false, reason: 'server_no_local_executor' };
  }
  return { ok: true, reason: 'ok' };
}

function buildUnavailableMessage(reason) {
  if (reason === 'server_no_local_executor') {
    return '当前部署在 server 模式，未配置可用执行器。请切换 Host 模式或配置 ARIS_CU_REMOTE_ENDPOINT。';
  }
  return 'computer-use 未启用。';
}

function buildToolOutput(job = {}) {
  return {
    job_id: job.id || '',
    status: job.status || 'queued',
    summary: String(job.summary || ''),
    steps_executed: Number(job.steps_executed || 0),
    last_screenshot_ref: String(job.last_screenshot_ref || ''),
    confirm_round: Number(job.confirm_round || 0)
  };
}

async function createComputerUseJobFromInput(input = {}, context = null) {
  const cfg = getComputerUseRuntimeConfig();
  const availability = getComputerUseAvailability(cfg);
  if (!availability.ok) {
    return {
      ok: false,
      type: 'degraded',
      reason: availability.reason,
      message: buildUnavailableMessage(availability.reason)
    };
  }

  const objective = String(input.objective || '').trim();
  if (!objective) {
    return {
      ok: false,
      type: 'invalid_input',
      reason: 'missing_objective',
      message: '缺少 objective，无法创建 computer-use 任务。'
    };
  }

  const job = await createComputerUseJob({
    request_id: input.request_id,
    user_id: input.user_id,
    context_id: input.context_id,
    objective,
    trigger: input.trigger || 'skill',
    confirm_mode: input.confirm_mode || cfg.confirmMode,
    confirm_every_steps: input.confirm_every_steps || cfg.confirmEverySteps,
    step_max_retry: input.step_max_retry || cfg.stepMaxRetry,
    max_steps: input.max_steps || cfg.maxSteps,
    metadata: {
      ...(input.metadata || {}),
      planner_model: cfg.plannerModel,
      runtime_profile: cfg.profile
    }
  }, context);

  await logAudit('computer_use.job.created', {
    request_id: job.request_id,
    user_id: job.user_id,
    job_id: job.id,
    trigger: job.trigger,
    runtime_profile: cfg.profile
  }, context);

  const waited = await waitForComputerUseJob(job.id, cfg.syncWaitMs, 600, context);
  return {
    ok: true,
    type: 'created',
    job: waited || job
  };
}

function buildSkillMessageByStatus(job = {}) {
  if (job.status === JOB_STATUS.COMPLETED) {
    return job.summary || 'computer-use 任务已完成。';
  }
  if (job.status === JOB_STATUS.WAITING_CONFIRMATION) {
    return `computer-use 任务已执行 ${Number(job.steps_executed || 0)} 步，等待确认后继续。`;
  }
  if (job.status === JOB_STATUS.FAILED) {
    return `computer-use 任务失败：${job.error || 'unknown_error'}`;
  }
  if (job.status === JOB_STATUS.CANCELLED) {
    return `computer-use 任务已取消：${job.error || 'cancelled'}`;
  }
  return `computer-use 任务已创建，当前状态：${job.status || 'queued'}。`;
}

async function runComputerUseSkill(input = {}, context = null) {
  const created = await createComputerUseJobFromInput(input, context);
  if (!created.ok) {
    return {
      success: false,
      error: created.reason || created.type || 'computer_use_unavailable',
      status: 'degraded',
      message: created.message || 'computer-use 不可用。'
    };
  }

  const job = created.job || {};
  const success = job.status === JOB_STATUS.COMPLETED || job.status === JOB_STATUS.WAITING_CONFIRMATION;
  return {
    success,
    status: job.status,
    message: buildSkillMessageByStatus(job),
    ...buildToolOutput(job)
  };
}

function requireAgentToken(request, config = null) {
  const cfg = config || getComputerUseRuntimeConfig();
  const expected = String(cfg.agentToken || '').trim();
  if (!expected) {
    return {
      ok: false,
      status: 500,
      error: 'agent_token_not_configured'
    };
  }

  const got = String(
    request?.headers?.get?.('x-aris-agent-token')
    || request?.headers?.get?.('authorization')?.replace(/^Bearer\s+/i, '')
    || ''
  ).trim();

  if (!got || got !== expected) {
    return {
      ok: false,
      status: 401,
      error: 'agent_unauthorized'
    };
  }

  return { ok: true };
}

async function pollComputerUseJobForAgent(payload = {}, context = null) {
  const cfg = getComputerUseRuntimeConfig();
  const availability = getComputerUseAvailability(cfg);
  if (!availability.ok) {
    return {
      ok: true,
      job: null,
      degraded: availability.reason
    };
  }

  const leased = await leaseNextComputerUseJob({
    agentId: payload.agent_id || 'agent',
    leaseTtlSec: cfg.leaseTtlSec
  }, context);

  if (!leased) {
    return { ok: true, job: null };
  }

  await logAudit('computer_use.job.leased', {
    request_id: leased.request_id,
    user_id: leased.user_id,
    job_id: leased.id,
    agent_id: leased.lease?.agent_id || payload.agent_id || 'agent'
  }, context);

  return {
    ok: true,
    job: sanitizeJobForAgent(leased)
  };
}

async function reportComputerUseJobFromAgent(payload = {}, context = null) {
  const out = await reportComputerUseProgress(payload, context);
  if (!out.ok) return out;

  const job = out.job || {};
  await logAudit('computer_use.job.reported', {
    request_id: job.request_id,
    user_id: job.user_id,
    job_id: job.id,
    agent_id: payload.agent_id || '',
    report_type: payload.report_type || 'step',
    status: job.status,
    error: job.error || null
  }, context);

  return {
    ok: true,
    job
  };
}

async function confirmComputerUseJobById(jobId, context = null) {
  const job = await confirmComputerUseJob(jobId, context);
  if (!job) return null;
  await logAudit('computer_use.job.confirmed', {
    request_id: job.request_id,
    user_id: job.user_id,
    job_id: job.id,
    status: job.status
  }, context);
  return job;
}

async function cancelComputerUseJobById(jobId, reason = 'cancelled_by_user', context = null) {
  const job = await cancelComputerUseJob(jobId, reason, context);
  if (!job) return null;
  await logAudit('computer_use.job.cancelled', {
    request_id: job.request_id,
    user_id: job.user_id,
    job_id: job.id,
    status: job.status,
    reason
  }, context);
  return job;
}

module.exports = {
  getComputerUseRuntimeConfig,
  getComputerUseAvailability,
  buildToolOutput,
  createComputerUseJobFromInput,
  runComputerUseSkill,
  requireAgentToken,
  pollComputerUseJobForAgent,
  reportComputerUseJobFromAgent,
  confirmComputerUseJobById,
  cancelComputerUseJobById,
  getComputerUseJob
};

