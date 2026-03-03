const { manualWrite, searchMemory } = require('../../v2/services/memoryService');

async function writeMemoryHandler(request, reply) {
  try {
    const item = await manualWrite(request.body || {}, request.ctx);
    reply.code(201).send({ success: true, item });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
}

async function searchMemoryHandler(request, reply) {
  const userId = String(request.query?.user_id || '').trim();
  const q = String(request.query?.q || '').trim();
  const limit = Math.max(1, Math.min(20, Number(request.query?.limit || 5)));

  if (!userId) {
    reply.code(400).send({ error: 'user_id is required' });
    return;
  }
  if (!q) {
    reply.code(400).send({ error: 'q is required' });
    return;
  }

  const items = await searchMemory(userId, q, limit, request.ctx);
  reply.send({ items, count: items.length });
}

module.exports = {
  writeMemoryHandler,
  searchMemoryHandler
};
