function buildStoreMappings(env = process.env) {
  return [
    { store: 'conversations', container: String(env.V2_CONVERSATIONS_CONTAINER || 'ConversationsV2') },
    { store: 'memory', container: String(env.V2_MEMORY_CONTAINER || 'MemoryV2') },
    { store: 'skills', container: String(env.V2_SKILLS_CONTAINER || 'SkillsV2') },
    { store: 'tasks', container: String(env.V2_TASKS_CONTAINER || 'TasksV2') },
    { store: 'computerUseJobs', container: String(env.V2_COMPUTER_USE_JOBS_CONTAINER || 'ComputerUseJobsV2') },
    { store: 'audit', container: String(env.V2_AUDIT_CONTAINER || 'AuditV2') }
  ];
}

function normalizeCosmosDoc(store, doc) {
  const out = { ...(doc || {}) };
  const partitionKey = String(out.partitionKey || 'global');
  if (!out.id) {
    out.id = `${store}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  out.partitionKey = partitionKey;
  return out;
}

module.exports = {
  buildStoreMappings,
  normalizeCosmosDoc
};
