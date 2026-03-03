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
  sanitizeJobForAgent,
  setComputerUseJobState
} = require('./computerUseQueue');
const { callMcpTool } = require('./computerUseMcpClient');

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

function normalizeTransport(value, fallback = 'mcp_stdio') {
  return normalizeMode(value, fallback, ['mcp_stdio', 'http_agent', 'hybrid']);
}

function parseCsvList(value) {
  if (!value) return [];
  const raw = String(value)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function hasGithubModelsToken(env = process.env) {
  return !!String(
    env.GITHUB_MODELS_TOKEN
    || env.GITHUB_TOKEN
    || env.GH_TOKEN
    || ''
  ).trim();
}

function normalizeProviderMode(value, fallback = 'auto') {
  return normalizeMode(value, fallback, ['github_models', 'openai_compatible', 'auto']);
}

function resolveProviderMode(env = process.env, configured = 'auto') {
  const mode = normalizeProviderMode(configured, 'auto');
  if (mode !== 'auto') return mode;
  return hasGithubModelsToken(env) ? 'github_models' : 'openai_compatible';
}

function parsePlannerModels(env = process.env) {
  const csv = parseCsvList(env.ARIS_CU_PLANNER_MODELS);
  if (csv.length > 0) return csv;

  const single = String(env.ARIS_CU_PLANNER_MODEL || '').trim();
  if (single) return [single];

  return ['openai/gpt-5-nano', 'openai/gpt-4.1-mini', 'openai/gpt-4o-mini'];
}

function resolveRelayEnabled(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase();
  const devEnable = parseBool(env.ARIS_CU_RELAY_ENABLE_DEV, true);
  const forceProd = parseBool(env.ARIS_CU_RELAY_FORCE_PROD, false);
  if (nodeEnv === 'production' && !forceProd) return false;
  return devEnable;
}

function getComputerUseRuntimeConfig(env = process.env) {
  const profile = normalizeMode(env.ARIS_RUNTIME_PROFILE, 'host', ['host', 'server']);
  const plannerModels = parsePlannerModels(env);
  const providerModeConfigured = normalizeProviderMode(env.ARIS_CU_PROVIDER_MODE, 'auto');
  const providerMode = resolveProviderMode(env, providerModeConfigured);
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
    plannerModels,
    plannerModel: plannerModels[0] || 'openai/gpt-4o-mini',
    providerModeConfigured,
    providerMode,
    agentToken: String(env.ARIS_CU_AGENT_TOKEN || '').trim(),
    transport: normalizeTransport(env.ARIS_CU_TRANSPORT, 'mcp_stdio'),
    mcpServerCmd: String(env.ARIS_CU_MCP_SERVER_CMD || 'python3 main.py').trim(),
    mcpServerCwd: String(env.ARIS_CU_MCP_SERVER_CWD || 'local/mcp-computer-use-server').trim(),
    mcpTimeoutMs: clampInt(env.ARIS_CU_MCP_TIMEOUT_MS, 1000, 180000, 30000),
    openaiBaseUrl: String(env.ARIS_CU_OPENAI_BASE_URL || 'https://models.github.ai/inference').trim(),
    relay: {
      provider: String(env.ARIS_CU_RELAY_PROVIDER || 'chatgpt_plus_poc').trim(),
      enabled: resolveRelayEnabled(env),
      maxRetry: clampInt(env.ARIS_CU_RELAY_MAX_RETRY, 0, 10, 2),
      timeoutMs: clampInt(env.ARIS_CU_RELAY_TIMEOUT_MS, 1000, 180000, 45000),
      browserProfileDir: String(env.ARIS_CU_RELAY_BROWSER_PROFILE_DIR || '').trim(),
      headless: parseBool(env.ARIS_CU_RELAY_HEADLESS, false),
      forceProd: parseBool(env.ARIS_CU_RELAY_FORCE_PROD, false)
    }
  };
}

function getComputerUseAvailability(config, options = {}) {
  const cfg = config || getComputerUseRuntimeConfig();
  const transport = normalizeTransport(options.transport || cfg.transport, cfg.transport);

  if (!cfg.enabled) return { ok: false, reason: 'computer_use_disabled' };

  if (cfg.profile === 'server' && !cfg.remoteEndpoint && transport !== 'http_agent') {
    return { ok: false, reason: 'server_no_local_executor' };
  }

  if (cfg.profile === 'server' && !cfg.remoteEndpoint && transport === 'http_agent') {
    return { ok: false, reason: 'server_no_local_executor' };
  }

  if ((transport === 'mcp_stdio' || transport === 'hybrid') && !cfg.mcpServerCmd) {
    return { ok: false, reason: 'mcp_server_not_configured' };
  }

  return { ok: true, reason: 'ok' };
}

function buildUnavailableMessage(reason) {
  if (reason === 'server_no_local_executor') {
    return '当前部署在 server 模式，未配置可用执行器。请切换 Host 模式或配置 ARIS_CU_REMOTE_ENDPOINT。';
  }
  if (reason === 'mcp_server_not_configured') {
    return '未配置 MCP stdio server 启动命令，无法执行 computer-use。';
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
    confirm_round: Number(job.confirm_round || 0),
    transport: String(job.transport || 'unknown'),
    provider: String(job.provider || 'unknown'),
    provider_mode: String(job.provider_mode || 'unknown'),
    provider_attempts: Number(job.provider_attempts || 0),
    provider_fallback_used: Number(job.provider_attempts || 0) > 1,
    provider_error_chain: Array.isArray(job.provider_error_chain) ? job.provider_error_chain : [],
    planner_model_selected: String(job.planner_model_selected || ''),
    planner_model_attempts: Number(job.planner_model_attempts || 0)
  };
}

async function createComputerUseJobFromInput(input = {}, context = null) {
  const cfg = getComputerUseRuntimeConfig();
  const transport = normalizeTransport(input.transport || 'http_agent', 'http_agent');
  const availability = getComputerUseAvailability(cfg, { transport });
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
    transport,
    provider_mode: String(input.provider_mode || cfg.providerMode || 'unknown'),
    provider: String(input.provider || 'unknown'),
    provider_attempts: Number(input.provider_attempts || 0),
    provider_error_chain: Array.isArray(input.provider_error_chain) ? input.provider_error_chain : [],
    metadata: {
      ...(input.metadata || {}),
      planner_model: cfg.plannerModel,
      planner_models: cfg.plannerModels,
      provider_mode: cfg.providerMode,
      runtime_profile: cfg.profile,
      transport
    }
  }, context);

  await logAudit('computer_use.job.created', {
    request_id: job.request_id,
    user_id: job.user_id,
    job_id: job.id,
    trigger: job.trigger,
    runtime_profile: cfg.profile,
    transport
  }, context);

  if (parseBool(input.skip_wait, false)) {
    return {
      ok: true,
      type: 'created',
      job
    };
  }

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

function normalizeMcpResult(raw = {}) {
  const status = String(raw.status || '').trim().toLowerCase() || (raw.success === false ? 'failed' : 'completed');
  const mapped = (status === 'completed' || status === 'waiting_confirmation' || status === 'failed')
    ? status
    : (raw.success === false ? 'failed' : 'completed');

  return {
    success: raw.success !== false,
    status: mapped,
    summary: String(raw.summary || ''),
    error: raw.error ? String(raw.error) : null,
    steps_executed: clampInt(raw.steps_executed, 0, 100000, 0),
    confirm_round: clampInt(raw.confirm_round, 0, 9999, 0),
    last_screenshot_ref: String(raw.last_screenshot_ref || ''),
    provider: String(raw.provider || 'unknown'),
    provider_mode: String(raw.provider_mode || 'unknown'),
    provider_attempts: clampInt(raw.provider_attempts, 0, 1000, 0),
    provider_fallback_used: !!raw.provider_fallback_used,
    provider_error_chain: Array.isArray(raw.provider_error_chain) ? raw.provider_error_chain : [],
    planner_model_selected: String(raw.planner_model_selected || ''),
    planner_model_attempts: clampInt(raw.planner_model_attempts, 0, 1000, 0),
    steps: Array.isArray(raw.steps) ? raw.steps : [],
    experimental: !!raw.experimental,
    output: raw.output ?? null
  };
}

async function runViaMcp(input = {}, context = null, cfg = null) {
  const runtime = cfg || getComputerUseRuntimeConfig();
  const created = await createComputerUseJobFromInput({
    ...input,
    transport: 'mcp_stdio',
    provider: 'openai_byok',
    provider_mode: runtime.providerMode,
    skip_wait: true
  }, context);

  if (!created.ok) {
    return {
      success: false,
      status: 'degraded',
      error: created.reason || created.type || 'computer_use_unavailable',
      message: created.message || 'computer-use 不可用。',
      provider_error_chain: []
    };
  }

  const job = created.job;
  const mcpEnv = {
    ARIS_CU_PLANNER_MODEL: runtime.plannerModel,
    ARIS_CU_PLANNER_MODELS: runtime.plannerModels.join(','),
    ARIS_CU_PROVIDER_MODE: runtime.providerMode,
    ARIS_CU_OPENAI_BASE_URL: runtime.openaiBaseUrl,
    ARIS_CU_RELAY_ENABLE_DEV: String(runtime.relay.enabled),
    ARIS_CU_RELAY_MAX_RETRY: String(runtime.relay.maxRetry),
    ARIS_CU_RELAY_TIMEOUT_MS: String(runtime.relay.timeoutMs),
    ARIS_CU_RELAY_PROVIDER: runtime.relay.provider,
    ARIS_CU_RELAY_BROWSER_PROFILE_DIR: runtime.relay.browserProfileDir,
    ARIS_CU_RELAY_HEADLESS: String(runtime.relay.headless),
    ARIS_CU_RELAY_FORCE_PROD: String(runtime.relay.forceProd)
  };

  let parsed;
  try {
    const out = await callMcpTool('run_task', {
      objective: String(input.objective || '').trim(),
      max_steps: Number(input.max_steps || runtime.maxSteps),
      step_max_retry: Number(input.step_max_retry || runtime.stepMaxRetry),
      confirm_mode: String(input.confirm_mode || runtime.confirmMode),
      confirm_every_steps: Number(input.confirm_every_steps || runtime.confirmEverySteps),
      allow_relay: !!runtime.relay.enabled,
      request_id: input.request_id,
      user_id: input.user_id,
      context_id: input.context_id,
      metadata: input.metadata || {}
    }, {
      cmd: runtime.mcpServerCmd,
      cwd: runtime.mcpServerCwd,
      timeoutMs: runtime.mcpTimeoutMs,
      env: mcpEnv
    }, context);
    parsed = normalizeMcpResult(out || {});
  } catch (err) {
    const msg = String(err?.message || err || 'mcp_execution_failed');
    parsed = {
      success: false,
      status: 'failed',
      error: 'mcp_execution_failed',
      summary: msg,
      steps_executed: 0,
      confirm_round: 0,
      last_screenshot_ref: '',
      provider: 'unknown',
      provider_mode: runtime.providerMode,
      provider_attempts: 1,
      provider_fallback_used: false,
      provider_error_chain: [{
        provider: 'mcp_stdio',
        code: 'mcp_execution_failed',
        message: msg
      }],
      steps: [],
      experimental: false,
      output: null
    };
  }

  const finalStatus = parsed.status === 'waiting_confirmation'
    ? JOB_STATUS.WAITING_CONFIRMATION
    : (parsed.success ? JOB_STATUS.COMPLETED : JOB_STATUS.FAILED);

  const updated = await setComputerUseJobState(job.id, {
    status: finalStatus,
    summary: parsed.summary,
    error: parsed.success ? null : parsed.error,
    output: parsed.output,
    steps_executed: parsed.steps_executed,
    confirm_round: parsed.confirm_round,
    last_screenshot_ref: parsed.last_screenshot_ref,
    transport: 'mcp_stdio',
    provider: parsed.provider,
    provider_mode: parsed.provider_mode || runtime.providerMode,
    provider_attempts: parsed.provider_attempts,
    provider_error_chain: parsed.provider_error_chain,
    planner_model_selected: parsed.planner_model_selected,
    planner_model_attempts: parsed.planner_model_attempts,
    steps: parsed.steps
  }, context);

  await logAudit('computer_use.job.mcp.completed', {
    request_id: updated?.request_id || input.request_id,
    user_id: updated?.user_id || input.user_id,
    job_id: job.id,
    status: finalStatus,
    transport: 'mcp_stdio',
    provider: parsed.provider,
    provider_mode: parsed.provider_mode || runtime.providerMode,
    provider_attempts: parsed.provider_attempts,
    planner_model_selected: parsed.planner_model_selected || '',
    planner_model_attempts: parsed.planner_model_attempts || 0,
    experimental: parsed.experimental,
    error: parsed.success ? null : parsed.error
  }, context);

  const finalJob = updated || {
    ...job,
    status: finalStatus,
    summary: parsed.summary,
    error: parsed.success ? null : parsed.error,
    steps_executed: parsed.steps_executed,
    confirm_round: parsed.confirm_round,
    last_screenshot_ref: parsed.last_screenshot_ref,
    transport: 'mcp_stdio',
    provider: parsed.provider,
    provider_attempts: parsed.provider_attempts,
    provider_error_chain: parsed.provider_error_chain,
    provider_mode: parsed.provider_mode || runtime.providerMode,
    planner_model_selected: parsed.planner_model_selected || '',
    planner_model_attempts: parsed.planner_model_attempts || 0
  };

  return {
    success: parsed.success || finalStatus === JOB_STATUS.WAITING_CONFIRMATION,
    status: finalJob.status,
    message: buildSkillMessageByStatus(finalJob),
    ...buildToolOutput(finalJob)
  };
}

async function runViaHttpAgent(input = {}, context = null) {
  const created = await createComputerUseJobFromInput({
    ...input,
    transport: 'http_agent'
  }, context);

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

async function runComputerUseSkill(input = {}, context = null) {
  const cfg = getComputerUseRuntimeConfig();

  if (cfg.transport === 'http_agent') {
    const availability = getComputerUseAvailability(cfg, { transport: 'http_agent' });
    if (!availability.ok) {
      return {
        success: false,
        error: availability.reason,
        status: 'degraded',
        message: buildUnavailableMessage(availability.reason)
      };
    }
    return runViaHttpAgent(input, context);
  }

  if (cfg.transport === 'mcp_stdio') {
    const availability = getComputerUseAvailability(cfg, { transport: 'mcp_stdio' });
    if (!availability.ok) {
      return {
        success: false,
        error: availability.reason,
        status: 'degraded',
        message: buildUnavailableMessage(availability.reason)
      };
    }
    return runViaMcp(input, context, cfg);
  }

  // hybrid: mcp first, then fallback to http_agent
  const mcpAvailability = getComputerUseAvailability(cfg, { transport: 'mcp_stdio' });
  if (!mcpAvailability.ok) {
    const httpAvailability = getComputerUseAvailability(cfg, { transport: 'http_agent' });
    if (!httpAvailability.ok) {
      return {
        success: false,
        error: mcpAvailability.reason,
        status: 'degraded',
        message: buildUnavailableMessage(mcpAvailability.reason)
      };
    }
    return runViaHttpAgent({
      ...input,
      provider_error_chain: [{
        provider: 'mcp_stdio',
        code: 'mcp_unavailable',
        message: buildUnavailableMessage(mcpAvailability.reason)
      }],
      provider_attempts: 1
    }, context);
  }

  const mcpOut = await runViaMcp(input, context, cfg);
  if (mcpOut.success) return mcpOut;

  const chain = Array.isArray(mcpOut.provider_error_chain)
    ? mcpOut.provider_error_chain
    : [{ provider: 'mcp_stdio', code: 'mcp_failed', message: String(mcpOut.message || mcpOut.error || 'mcp_failed') }];

  const httpOut = await runViaHttpAgent({
    ...input,
    provider: 'unknown',
    provider_attempts: Math.max(2, Number(mcpOut.provider_attempts || 0) + 1),
    provider_error_chain: chain
  }, context);

  return {
    ...httpOut,
    provider_fallback_used: true,
    provider_error_chain: chain,
    provider: httpOut.provider || 'unknown',
    provider_attempts: Math.max(2, Number(httpOut.provider_attempts || 0))
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
  const availability = getComputerUseAvailability(cfg, { transport: 'http_agent' });
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
  getComputerUseJob,
  normalizeTransport,
  resolveRelayEnabled,
  resolveProviderMode,
  parsePlannerModels
};
