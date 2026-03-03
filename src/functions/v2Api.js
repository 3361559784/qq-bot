const { app } = require('@azure/functions');
const { parseJsonBody, jsonResponse, encodeSse, sseHeaders, clampNumber } = require('../v2/utils');
const { normalizeMessageRequest, normalizeMessageResponse } = require('../v2/core/channelAdapter');
const { handleConversation } = require('../v2/core/conversationCore');
const { manualWrite, searchMemory } = require('../v2/services/memoryService');
const { listInstalledSkills, installSkill, uninstallSkill } = require('../v2/services/skillRuntime');
const { createTask, listTasks, patchTask, removeTask, startScheduler } = require('../v2/services/taskScheduler');
const { logAudit } = require('../v2/services/auditService');
const {
  createComputerUseJobFromInput,
  requireAgentToken,
  pollComputerUseJobForAgent,
  reportComputerUseJobFromAgent,
  confirmComputerUseJobById,
  cancelComputerUseJobById,
  getComputerUseJob
} = require('../v2/services/computerUseService');

startScheduler();

function getRequestId(request, body = {}) {
  return String(
    body.request_id
    || body.requestId
    || request?.headers?.get?.('x-request-id')
    || `req_${Date.now()}`
  );
}

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
    transport: job.transport || 'http_agent',
    provider: job.provider || 'unknown',
    provider_attempts: Number(job.provider_attempts || 0),
    provider_error_chain: Array.isArray(job.provider_error_chain) ? job.provider_error_chain : [],
    created_at: job.created_at,
    updated_at: job.updated_at,
    lease: includeLease ? job.lease || null : undefined
  };
}

app.http('v2Messages', {
  route: 'v2/messages',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const body = await parseJsonBody(request);
    const req = normalizeMessageRequest(body, request);

    if (!req.content) {
      return jsonResponse({ error: 'content is required' }, 400);
    }

    const result = await handleConversation(req, context);
    return jsonResponse(normalizeMessageResponse(result), 200, {
      'x-request-id': req.request_id
    });
  }
});

app.http('v2MessagesStream', {
  route: 'v2/messages/stream',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const body = await parseJsonBody(request);
    const req = normalizeMessageRequest(body, request);

    if (!req.content) {
      return {
        status: 400,
        headers: sseHeaders(),
        body: encodeSse({ type: 'error', message: 'content is required' }) + encodeSse('[DONE]')
      };
    }

    try {
      const events = [];
      events.push(encodeSse({ type: 'thinking', stage: 'analyzing_request' }));

      const result = await handleConversation(req, context);
      const normalized = normalizeMessageResponse(result);

      if (Array.isArray(normalized.tool_calls)) {
        for (const call of normalized.tool_calls) {
          events.push(encodeSse({
            type: 'tool_call',
            tool: call.tool,
            status: call.status,
            duration_ms: call.duration_ms
          }));
        }
      }

      const text = String(normalized.content || '');
      const chunkSize = 6;
      for (let i = 0; i < text.length; i += chunkSize) {
        events.push(encodeSse({ type: 'token', content: text.slice(i, i + chunkSize) }));
      }

      events.push(encodeSse({
        type: 'meta',
        id: normalized.id,
        safety: normalized.safety,
        persona: normalized.persona,
        memory_refs: normalized.memory_refs,
        usage: normalized.usage,
        latency_ms: normalized.latency_ms,
        meta: normalized.meta
      }));
      events.push(encodeSse({ type: 'complete' }));
      events.push(encodeSse('[DONE]'));

      return {
        status: 200,
        headers: sseHeaders({ 'x-request-id': req.request_id }),
        body: events.join('')
      };
    } catch (err) {
      return {
        status: 500,
        headers: sseHeaders({ 'x-request-id': req.request_id }),
        body: encodeSse({ type: 'error', message: err.message }) + encodeSse('[DONE]')
      };
    }
  }
});

app.http('v2SkillsList', {
  route: 'v2/skills',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (_request, context) => {
    const skills = await listInstalledSkills(context);
    return jsonResponse({ items: skills, count: skills.length });
  }
});

app.http('v2SkillsInstall', {
  route: 'v2/skills/install',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const body = await parseJsonBody(request);
      const skill = await installSkill(body, context);
      await logAudit('v2.skill.installed', { skill: skill.name }, context);
      return jsonResponse({ success: true, skill }, 201);
    } catch (err) {
      return jsonResponse({ error: err.message }, 400);
    }
  }
});

app.http('v2SkillsDelete', {
  route: 'v2/skills/{name}',
  methods: ['DELETE'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const name = request.params?.name;
    if (!name) return jsonResponse({ error: 'name is required' }, 400);
    const ok = await uninstallSkill(name, context);
    if (!ok) return jsonResponse({ error: 'skill not found' }, 404);
    await logAudit('v2.skill.deleted', { skill: name }, context);
    return jsonResponse({ success: true });
  }
});

app.http('v2MemoryWrite', {
  route: 'v2/memory',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const body = await parseJsonBody(request);
      const item = await manualWrite(body, context);
      await logAudit('v2.memory.write', {
        user_id: item.user_id,
        kind: item.kind,
        scope: item.scope,
        memory_id: item.id
      }, context);
      return jsonResponse({ success: true, item }, 201);
    } catch (err) {
      return jsonResponse({ error: err.message }, 400);
    }
  }
});

app.http('v2MemorySearch', {
  route: 'v2/memory/search',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const userId = String(request.query.get('user_id') || '').trim();
    const q = String(request.query.get('q') || '').trim();
    const limit = clampNumber(request.query.get('limit'), 1, 20, 5);

    if (!userId) return jsonResponse({ error: 'user_id is required' }, 400);
    if (!q) return jsonResponse({ error: 'q is required' }, 400);

    const items = await searchMemory(userId, q, limit, context);
    return jsonResponse({ items, count: items.length });
  }
});

app.http('v2TasksList', {
  route: 'v2/tasks',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (_request, context) => {
    const items = await listTasks(context);
    return jsonResponse({ items, count: items.length });
  }
});

app.http('v2TasksCreate', {
  route: 'v2/tasks',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const body = await parseJsonBody(request);
      const task = await createTask(body, context);
      await logAudit('v2.task.created', { task_id: task.id, skill: task.skill }, context);
      return jsonResponse({ success: true, task }, 201);
    } catch (err) {
      return jsonResponse({ error: err.message }, 400);
    }
  }
});

app.http('v2TasksPatch', {
  route: 'v2/tasks/{id}',
  methods: ['PATCH'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const id = String(request.params?.id || '').trim();
      if (!id) return jsonResponse({ error: 'id is required' }, 400);
      const body = await parseJsonBody(request);
      const task = await patchTask(id, body, context);
      await logAudit('v2.task.updated', { task_id: task.id }, context);
      return jsonResponse({ success: true, task });
    } catch (err) {
      return jsonResponse({ error: err.message }, 400);
    }
  }
});

app.http('v2TasksDelete', {
  route: 'v2/tasks/{id}',
  methods: ['DELETE'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const id = String(request.params?.id || '').trim();
    if (!id) return jsonResponse({ error: 'id is required' }, 400);
    const ok = await removeTask(id, context);
    if (!ok) return jsonResponse({ error: 'task not found' }, 404);
    await logAudit('v2.task.deleted', { task_id: id }, context);
    return jsonResponse({ success: true });
  }
});

async function v2ComputerUseJobsCreateHandler(request, context) {
  const body = await parseJsonBody(request);
  const objective = String(body.objective || '').trim();
  if (!objective) return jsonResponse({ error: 'objective is required' }, 400);

  const created = await createComputerUseJobFromInput({
    request_id: getRequestId(request, body),
    user_id: String(body.user_id || body.userId || 'web_unknown'),
    context_id: String(body.context_id || body.contextId || `web_${body.user_id || body.userId || 'unknown'}`),
    objective,
    trigger: String(body.trigger || 'api'),
    confirm_mode: body.confirm_mode,
    confirm_every_steps: body.confirm_every_steps,
    step_max_retry: body.step_max_retry,
    max_steps: body.max_steps,
    transport: 'http_agent',
    metadata: body.metadata || {}
  }, context);

  if (!created.ok) {
    return jsonResponse({
      success: false,
      degraded: true,
      error: created.reason || created.type || 'computer_use_unavailable',
      message: created.message || 'computer-use unavailable'
    }, 200);
  }

  const job = sanitizeComputerUseJob(created.job);
  return jsonResponse({ success: true, job }, 201);
}

async function v2ComputerUseJobGetHandler(request, context) {
  const id = String(request.params?.id || '').trim();
  if (!id) return jsonResponse({ error: 'id is required' }, 400);

  const job = await getComputerUseJob(id, context);
  if (!job) return jsonResponse({ error: 'job not found' }, 404);
  return jsonResponse({ success: true, job: sanitizeComputerUseJob(job) }, 200);
}

async function v2ComputerUseJobConfirmHandler(request, context) {
  const id = String(request.params?.id || '').trim();
  if (!id) return jsonResponse({ error: 'id is required' }, 400);

  const job = await confirmComputerUseJobById(id, context);
  if (!job) return jsonResponse({ error: 'job not found' }, 404);
  return jsonResponse({ success: true, job: sanitizeComputerUseJob(job) }, 200);
}

async function v2ComputerUseJobCancelHandler(request, context) {
  const id = String(request.params?.id || '').trim();
  if (!id) return jsonResponse({ error: 'id is required' }, 400);
  const body = await parseJsonBody(request);

  const job = await cancelComputerUseJobById(id, body.reason || 'cancelled_by_user', context);
  if (!job) return jsonResponse({ error: 'job not found' }, 404);
  return jsonResponse({ success: true, job: sanitizeComputerUseJob(job) }, 200);
}

async function v2ComputerUseAgentPollHandler(request, context) {
  const auth = requireAgentToken(request);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status || 401);

  const body = await parseJsonBody(request);
  const out = await pollComputerUseJobForAgent({
    agent_id: String(body.agent_id || body.agentId || 'agent')
  }, context);

  return jsonResponse({
    success: true,
    degraded: out.degraded || null,
    job: out.job ? sanitizeComputerUseJob(out.job, { includeLease: true }) : null
  }, 200);
}

async function v2ComputerUseAgentReportHandler(request, context) {
  const auth = requireAgentToken(request);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status || 401);

  const body = await parseJsonBody(request);
  const out = await reportComputerUseJobFromAgent({
    job_id: body.job_id || body.jobId,
    agent_id: body.agent_id || body.agentId,
    lease_token: body.lease_token || body.leaseToken,
    report_type: body.report_type || body.reportType || 'step',
    step: body.step,
    result: body.result,
    error: body.error
  }, context);

  if (!out.ok) return jsonResponse({ success: false, error: out.error }, 400);
  return jsonResponse({ success: true, job: sanitizeComputerUseJob(out.job, { includeLease: true }) }, 200);
}

async function v2ComputerUseAgentHeartbeatHandler(request, context) {
  const auth = requireAgentToken(request);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status || 401);

  const body = await parseJsonBody(request);
  const jobId = String(body.job_id || body.jobId || '').trim();
  if (!jobId) {
    await logAudit('computer_use.agent.heartbeat', {
      agent_id: String(body.agent_id || body.agentId || 'agent'),
      request_id: getRequestId(request, body)
    }, context);
    return jsonResponse({ success: true, heartbeat: 'ok' }, 200);
  }

  const out = await reportComputerUseJobFromAgent({
    job_id: jobId,
    agent_id: body.agent_id || body.agentId,
    lease_token: body.lease_token || body.leaseToken,
    report_type: 'heartbeat'
  }, context);
  if (!out.ok) return jsonResponse({ success: false, error: out.error }, 400);
  return jsonResponse({ success: true, job: sanitizeComputerUseJob(out.job, { includeLease: true }) }, 200);
}

app.http('v2ComputerUseJobsCreate', {
  route: 'v2/computer-use/jobs',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: v2ComputerUseJobsCreateHandler
});

app.http('v2ComputerUseJobGet', {
  route: 'v2/computer-use/jobs/{id}',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: v2ComputerUseJobGetHandler
});

app.http('v2ComputerUseJobConfirm', {
  route: 'v2/computer-use/jobs/{id}/confirm',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: v2ComputerUseJobConfirmHandler
});

app.http('v2ComputerUseJobCancel', {
  route: 'v2/computer-use/jobs/{id}/cancel',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: v2ComputerUseJobCancelHandler
});

app.http('v2ComputerUseAgentPoll', {
  route: 'v2/computer-use/agent/poll',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: v2ComputerUseAgentPollHandler
});

app.http('v2ComputerUseAgentReport', {
  route: 'v2/computer-use/agent/report',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: v2ComputerUseAgentReportHandler
});

app.http('v2ComputerUseAgentHeartbeat', {
  route: 'v2/computer-use/agent/heartbeat',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: v2ComputerUseAgentHeartbeatHandler
});

module.exports = {
  v2ComputerUseJobsCreateHandler,
  v2ComputerUseJobGetHandler,
  v2ComputerUseJobConfirmHandler,
  v2ComputerUseJobCancelHandler,
  v2ComputerUseAgentPollHandler,
  v2ComputerUseAgentReportHandler,
  v2ComputerUseAgentHeartbeatHandler
};
