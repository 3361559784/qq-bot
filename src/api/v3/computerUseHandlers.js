const {
  createComputerUseJobFromInput,
  requireAgentToken,
  pollComputerUseJobForAgent,
  reportComputerUseJobFromAgent,
  confirmComputerUseJobById,
  cancelComputerUseJobById,
  getComputerUseJob
} = require('../../v2/services/computerUseService');
const { makeRequestLike } = require('./helpers');

function sanitizeComputerUseJob(job = {}, options = {}) {
  if (!job || typeof job !== 'object') return null;
  const includeLease = !!options.includeLease;
  return {
    id: job.id,
    request_id: job.request_id,
    user_id: job.user_id,
    context_id: job.context_id,
    objective: job.objective,
    trigger: job.trigger,
    status: job.status,
    confirm_mode: job.confirm_mode,
    confirm_every_steps: Number(job.confirm_every_steps || 0),
    step_max_retry: Number(job.step_max_retry || 0),
    max_steps: Number(job.max_steps || 0),
    steps_executed: Number(job.steps_executed || 0),
    confirm_round: Number(job.confirm_round || 0),
    steps: Array.isArray(job.steps) ? job.steps : [],
    summary: job.summary || '',
    output: job.output ?? null,
    error: job.error || null,
    last_screenshot_ref: job.last_screenshot_ref || '',
    transport: job.transport || 'unknown',
    provider: job.provider || 'unknown',
    provider_mode: job.provider_mode || 'unknown',
    provider_attempts: Number(job.provider_attempts || 0),
    provider_error_chain: Array.isArray(job.provider_error_chain) ? job.provider_error_chain : [],
    planner_model_selected: String(job.planner_model_selected || ''),
    planner_model_attempts: Number(job.planner_model_attempts || 0),
    created_at: job.created_at,
    updated_at: job.updated_at,
    lease: includeLease ? job.lease || null : undefined
  };
}

function validateAgentAuth(request, reply) {
  const auth = requireAgentToken(makeRequestLike(request));
  if (!auth.ok) {
    reply.code(auth.status || 401).send({ error: auth.error });
    return false;
  }
  return true;
}

async function createJobHandler(request, reply) {
  const body = request.body || {};
  const objective = String(body.objective || '').trim();
  if (!objective) {
    reply.code(400).send({ error: 'objective is required' });
    return;
  }

  const created = await createComputerUseJobFromInput({
    request_id: String(body.request_id || body.requestId || request.ctx?.requestId || `req_${Date.now()}`),
    user_id: String(body.user_id || body.userId || 'web_unknown'),
    context_id: String(body.context_id || body.contextId || `web_${body.user_id || body.userId || 'unknown'}`),
    objective,
    trigger: String(body.trigger || 'api'),
    confirm_mode: body.confirm_mode,
    confirm_every_steps: body.confirm_every_steps,
    step_max_retry: body.step_max_retry,
    max_steps: body.max_steps,
    transport: body.transport || undefined,
    metadata: body.metadata || {}
  }, request.ctx);

  if (!created.ok) {
    reply.send({
      success: false,
      degraded: true,
      error: created.reason || created.type || 'computer_use_unavailable',
      message: created.message || 'computer-use unavailable'
    });
    return;
  }

  reply.code(201).send({ success: true, job: sanitizeComputerUseJob(created.job) });
}

async function getJobHandler(request, reply) {
  const id = String(request.params?.id || '').trim();
  if (!id) {
    reply.code(400).send({ error: 'id is required' });
    return;
  }

  const job = await getComputerUseJob(id, request.ctx);
  if (!job) {
    reply.code(404).send({ error: 'job not found' });
    return;
  }

  reply.send({ success: true, job: sanitizeComputerUseJob(job) });
}

async function confirmJobHandler(request, reply) {
  const id = String(request.params?.id || '').trim();
  if (!id) {
    reply.code(400).send({ error: 'id is required' });
    return;
  }

  const job = await confirmComputerUseJobById(id, request.ctx);
  if (!job) {
    reply.code(404).send({ error: 'job not found' });
    return;
  }

  reply.send({ success: true, job: sanitizeComputerUseJob(job) });
}

async function cancelJobHandler(request, reply) {
  const id = String(request.params?.id || '').trim();
  if (!id) {
    reply.code(400).send({ error: 'id is required' });
    return;
  }

  const body = request.body || {};
  const job = await cancelComputerUseJobById(id, body.reason || 'cancelled_by_user', request.ctx);
  if (!job) {
    reply.code(404).send({ error: 'job not found' });
    return;
  }

  reply.send({ success: true, job: sanitizeComputerUseJob(job) });
}

async function agentPollHandler(request, reply) {
  if (!validateAgentAuth(request, reply)) return;
  const body = request.body || {};
  const out = await pollComputerUseJobForAgent({
    agent_id: String(body.agent_id || body.agentId || 'agent')
  }, request.ctx);

  reply.send({
    success: true,
    degraded: out.degraded || null,
    job: out.job ? sanitizeComputerUseJob(out.job, { includeLease: true }) : null
  });
}

async function agentReportHandler(request, reply) {
  if (!validateAgentAuth(request, reply)) return;
  const body = request.body || {};
  const out = await reportComputerUseJobFromAgent({
    job_id: body.job_id || body.jobId,
    agent_id: body.agent_id || body.agentId,
    lease_token: body.lease_token || body.leaseToken,
    report_type: body.report_type || body.reportType || 'step',
    step: body.step,
    result: body.result,
    error: body.error
  }, request.ctx);

  if (!out.ok) {
    reply.code(400).send({ success: false, error: out.error });
    return;
  }
  reply.send({ success: true, job: sanitizeComputerUseJob(out.job, { includeLease: true }) });
}

async function agentHeartbeatHandler(request, reply) {
  if (!validateAgentAuth(request, reply)) return;
  const body = request.body || {};
  const jobId = String(body.job_id || body.jobId || '').trim();
  if (!jobId) {
    reply.send({ success: true, heartbeat: 'ok' });
    return;
  }

  const out = await reportComputerUseJobFromAgent({
    job_id: jobId,
    agent_id: body.agent_id || body.agentId,
    lease_token: body.lease_token || body.leaseToken,
    report_type: 'heartbeat'
  }, request.ctx);

  if (!out.ok) {
    reply.code(400).send({ success: false, error: out.error });
    return;
  }

  reply.send({ success: true, job: sanitizeComputerUseJob(out.job, { includeLease: true }) });
}

module.exports = {
  createJobHandler,
  getJobHandler,
  confirmJobHandler,
  cancelJobHandler,
  agentPollHandler,
  agentReportHandler,
  agentHeartbeatHandler
};
