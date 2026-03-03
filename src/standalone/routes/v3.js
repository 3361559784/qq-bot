const {
  postChat,
  postChatStream
} = require('../../api/v3/chatHandlers');
const {
  listSkills,
  installSkillHandler,
  deleteSkillHandler
} = require('../../api/v3/skillHandlers');
const {
  writeMemoryHandler,
  searchMemoryHandler
} = require('../../api/v3/memoryHandlers');
const {
  listTasksHandler,
  createTaskHandler,
  patchTaskHandler,
  deleteTaskHandler
} = require('../../api/v3/taskHandlers');
const {
  createJobHandler,
  getJobHandler,
  confirmJobHandler,
  cancelJobHandler,
  agentPollHandler,
  agentReportHandler,
  agentHeartbeatHandler
} = require('../../api/v3/computerUseHandlers');

async function v3Routes(fastify) {
  fastify.post('/chat', postChat);
  fastify.post('/chat/stream', postChatStream);

  fastify.get('/skills', listSkills);
  fastify.post('/skills/install', installSkillHandler);
  fastify.delete('/skills/:name', deleteSkillHandler);

  fastify.post('/memory', writeMemoryHandler);
  fastify.get('/memory/search', searchMemoryHandler);

  fastify.get('/tasks', listTasksHandler);
  fastify.post('/tasks', createTaskHandler);
  fastify.patch('/tasks/:id', patchTaskHandler);
  fastify.delete('/tasks/:id', deleteTaskHandler);

  fastify.post('/computer-use/jobs', createJobHandler);
  fastify.get('/computer-use/jobs/:id', getJobHandler);
  fastify.post('/computer-use/jobs/:id/confirm', confirmJobHandler);
  fastify.post('/computer-use/jobs/:id/cancel', cancelJobHandler);

  fastify.post('/computer-use/agent/poll', agentPollHandler);
  fastify.post('/computer-use/agent/report', agentReportHandler);
  fastify.post('/computer-use/agent/heartbeat', agentHeartbeatHandler);
}

module.exports = {
  v3Routes
};
