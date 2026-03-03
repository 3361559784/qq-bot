const { createTask, listTasks, patchTask, removeTask } = require('../../v2/services/taskScheduler');

async function listTasksHandler(_request, reply) {
  const items = await listTasks();
  reply.send({ items, count: items.length });
}

async function createTaskHandler(request, reply) {
  try {
    const task = await createTask(request.body || {}, request.ctx);
    reply.code(201).send({ success: true, task });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
}

async function patchTaskHandler(request, reply) {
  try {
    const id = String(request.params?.id || '').trim();
    if (!id) {
      reply.code(400).send({ error: 'id is required' });
      return;
    }
    const task = await patchTask(id, request.body || {}, request.ctx);
    reply.send({ success: true, task });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
}

async function deleteTaskHandler(request, reply) {
  const id = String(request.params?.id || '').trim();
  if (!id) {
    reply.code(400).send({ error: 'id is required' });
    return;
  }

  const ok = await removeTask(id, request.ctx);
  if (!ok) {
    reply.code(404).send({ error: 'task not found' });
    return;
  }
  reply.send({ success: true });
}

module.exports = {
  listTasksHandler,
  createTaskHandler,
  patchTaskHandler,
  deleteTaskHandler
};
