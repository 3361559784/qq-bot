const { app } = require('@azure/functions');
const { parseJsonBody, jsonResponse, encodeSse, sseHeaders, clampNumber } = require('../v2/utils');
const { normalizeMessageRequest, normalizeMessageResponse } = require('../v2/core/channelAdapter');
const { handleConversation } = require('../v2/core/conversationCore');
const { manualWrite, searchMemory } = require('../v2/services/memoryService');
const { listInstalledSkills, installSkill, uninstallSkill } = require('../v2/services/skillRuntime');
const { createTask, listTasks, patchTask, removeTask, startScheduler } = require('../v2/services/taskScheduler');
const { logAudit } = require('../v2/services/auditService');

startScheduler();

function getRequestHeader(request, name) {
  return request?.headers?.get?.(name) || request?.headers?.get?.(name.toLowerCase()) || '';
}

function getAdminToken() {
  return String(
    process.env.V2_ADMIN_TOKEN ||
    process.env.ARIS_ADMIN_TOKEN ||
    process.env.ADMIN_TOKEN ||
    ''
  ).trim();
}

function readSuppliedAdminToken(request) {
  const authorization = String(getRequestHeader(request, 'authorization') || '').trim();
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, '').trim();
  }

  return String(
    getRequestHeader(request, 'x-v2-admin-token') ||
    getRequestHeader(request, 'x-api-key') ||
    ''
  ).trim();
}

async function withAdminAuth(request, context, handler) {
  const configuredToken = getAdminToken();
  if (!configuredToken) {
    context?.log?.('[v2/api] management endpoint blocked: missing V2_ADMIN_TOKEN');
    return jsonResponse({ error: 'v2 management endpoints are disabled until V2_ADMIN_TOKEN is configured' }, 503);
  }

  const suppliedToken = readSuppliedAdminToken(request);
  if (!suppliedToken || suppliedToken !== configuredToken) {
    context?.log?.('[v2/api] management endpoint unauthorized');
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  return handler();
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
  handler: async (request, context) => withAdminAuth(request, context, async () => {
    const skills = await listInstalledSkills(context);
    return jsonResponse({ items: skills, count: skills.length });
  })
});

app.http('v2SkillsInstall', {
  route: 'v2/skills/install',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => withAdminAuth(request, context, async () => {
    try {
      const body = await parseJsonBody(request);
      const skill = await installSkill(body, context);
      await logAudit('v2.skill.installed', { skill: skill.name }, context);
      return jsonResponse({ success: true, skill }, 201);
    } catch (err) {
      return jsonResponse({ error: err.message }, 400);
    }
  })
});

app.http('v2SkillsDelete', {
  route: 'v2/skills/{name}',
  methods: ['DELETE'],
  authLevel: 'anonymous',
  handler: async (request, context) => withAdminAuth(request, context, async () => {
    const name = request.params?.name;
    if (!name) return jsonResponse({ error: 'name is required' }, 400);
    const ok = await uninstallSkill(name, context);
    if (!ok) return jsonResponse({ error: 'skill not found' }, 404);
    await logAudit('v2.skill.deleted', { skill: name }, context);
    return jsonResponse({ success: true });
  })
});

app.http('v2MemoryWrite', {
  route: 'v2/memory',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => withAdminAuth(request, context, async () => {
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
  })
});

app.http('v2MemorySearch', {
  route: 'v2/memory/search',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => withAdminAuth(request, context, async () => {
    const userId = String(request.query.get('user_id') || '').trim();
    const q = String(request.query.get('q') || '').trim();
    const limit = clampNumber(request.query.get('limit'), 1, 20, 5);

    if (!userId) return jsonResponse({ error: 'user_id is required' }, 400);
    if (!q) return jsonResponse({ error: 'q is required' }, 400);

    const items = await searchMemory(userId, q, limit, context);
    return jsonResponse({ items, count: items.length });
  })
});

app.http('v2TasksList', {
  route: 'v2/tasks',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => withAdminAuth(request, context, async () => {
    const items = await listTasks(context);
    return jsonResponse({ items, count: items.length });
  })
});

app.http('v2TasksCreate', {
  route: 'v2/tasks',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => withAdminAuth(request, context, async () => {
    try {
      const body = await parseJsonBody(request);
      const task = await createTask(body, context);
      await logAudit('v2.task.created', { task_id: task.id, skill: task.skill }, context);
      return jsonResponse({ success: true, task }, 201);
    } catch (err) {
      return jsonResponse({ error: err.message }, 400);
    }
  })
});

app.http('v2TasksPatch', {
  route: 'v2/tasks/{id}',
  methods: ['PATCH'],
  authLevel: 'anonymous',
  handler: async (request, context) => withAdminAuth(request, context, async () => {
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
  })
});

app.http('v2TasksDelete', {
  route: 'v2/tasks/{id}',
  methods: ['DELETE'],
  authLevel: 'anonymous',
  handler: async (request, context) => withAdminAuth(request, context, async () => {
    const id = String(request.params?.id || '').trim();
    if (!id) return jsonResponse({ error: 'id is required' }, 400);
    const ok = await removeTask(id, context);
    if (!ok) return jsonResponse({ error: 'task not found' }, 404);
    await logAudit('v2.task.deleted', { task_id: id }, context);
    return jsonResponse({ success: true });
  })
});
