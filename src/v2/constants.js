function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function normalizeMode(value, fallback, allow) {
  const raw = String(value || '').trim().toLowerCase();
  if (allow.includes(raw)) return raw;
  return fallback;
}

function parseCsvList(value) {
  if (!value) return [];
  const seen = new Set();
  const out = [];
  for (const item of String(value).split(',')) {
    const v = item.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

const runtimeProfile = normalizeMode(process.env.ARIS_RUNTIME_PROFILE, 'host', ['host', 'server']);
const plannerModels = (() => {
  const csv = parseCsvList(process.env.ARIS_CU_PLANNER_MODELS);
  if (csv.length > 0) return csv;
  const single = String(process.env.ARIS_CU_PLANNER_MODEL || '').trim();
  if (single) return [single];
  return ['openai/gpt-5-nano', 'openai/gpt-4.1-mini', 'openai/gpt-4o-mini'];
})();

const V2_DEFAULTS = Object.freeze({
  apiVersion: 'v2',
  memory: {
    shortHistoryTurns: Number(process.env.V2_SHORT_HISTORY_TURNS || 8),
    summaryTriggerTurns: Number(process.env.V2_SUMMARY_TRIGGER_TURNS || 10),
    summaryMaxChars: Number(process.env.V2_SUMMARY_MAX_CHARS || 900),
    searchTopK: Number(process.env.V2_MEMORY_TOP_K || 4),
    similarityThreshold: Number(process.env.V2_MEMORY_SIMILARITY_THRESHOLD || 0.75),
    ttlDays: Number(process.env.V2_MEMORY_TTL_DAYS || 30)
  },
  scheduler: {
    pollMs: Number(process.env.V2_TASK_POLL_MS || 30000),
    maxRetry: Number(process.env.V2_TASK_MAX_RETRY || 3)
  },
  computerUse: {
    runtimeProfile,
    enabled: parseBool(process.env.ARIS_CU_ENABLED, runtimeProfile === 'host'),
    transport: normalizeMode(process.env.ARIS_CU_TRANSPORT, 'mcp_stdio', ['mcp_stdio', 'http_agent', 'hybrid']),
    providerMode: normalizeMode(process.env.ARIS_CU_PROVIDER_MODE, 'auto', ['github_models', 'openai_compatible', 'auto']),
    triggerMode: normalizeMode(process.env.ARIS_CU_TRIGGER_MODE, 'both', ['explicit', 'auto', 'both']),
    confirmMode: normalizeMode(process.env.ARIS_CU_CONFIRM_MODE, 'periodic', ['periodic', 'always', 'never']),
    confirmEverySteps: Number(process.env.ARIS_CU_CONFIRM_EVERY_STEPS || 5),
    stepMaxRetry: Number(process.env.ARIS_CU_STEP_MAX_RETRY || 2),
    maxSteps: Number(process.env.ARIS_CU_MAX_STEPS || 30),
    syncWaitMs: Number(process.env.ARIS_CU_SYNC_WAIT_MS || 18000),
    leaseTtlSec: Number(process.env.ARIS_CU_LEASE_TTL_SEC || 45),
    plannerModels,
    plannerModel: plannerModels[0] || 'openai/gpt-4o-mini',
    openaiBaseUrl: String(process.env.ARIS_CU_OPENAI_BASE_URL || 'https://models.github.ai/inference'),
    mcpServerCmd: String(process.env.ARIS_CU_MCP_SERVER_CMD || 'python3 main.py'),
    mcpServerCwd: String(process.env.ARIS_CU_MCP_SERVER_CWD || 'local/mcp-computer-use-server'),
    mcpTimeoutMs: Number(process.env.ARIS_CU_MCP_TIMEOUT_MS || 30000)
  },
  limits: {
    maxContentChars: Number(process.env.V2_MAX_CONTENT_CHARS || 6000),
    maxAttachments: Number(process.env.V2_MAX_ATTACHMENTS || 8)
  },
  db: {
    database: process.env.V2_DB_NAME || 'QQBotDB',
    containers: {
      conversations: process.env.V2_CONVERSATIONS_CONTAINER || 'ConversationsV2',
      memory: process.env.V2_MEMORY_CONTAINER || 'MemoryV2',
      skills: process.env.V2_SKILLS_CONTAINER || 'SkillsV2',
      tasks: process.env.V2_TASKS_CONTAINER || 'TasksV2',
      audit: process.env.V2_AUDIT_CONTAINER || 'AuditV2',
      computerUseJobs: process.env.V2_COMPUTER_USE_JOBS_CONTAINER || 'ComputerUseJobsV2'
    }
  }
});

const SAFETY_ACTION = Object.freeze({
  PASS: 'pass',
  DEGRADE: 'degrade',
  REFUSE: 'refuse'
});

const SAFETY_CATEGORY = Object.freeze({
  NONE: 'none',
  DELEGATED_ACTION: 'delegated_action',
  UNAUTHORIZED_ACTION: 'unauthorized_action',
  HIGH_RISK: 'high_risk',
  HARMFUL: 'harmful',
  PROMPT_INJECTION: 'prompt_injection',
  DECISION_MAKING: 'decision_making'
});

const MEMORY_KIND = Object.freeze({
  PROFILE: 'profile',
  PREFERENCE: 'preference',
  FACT: 'fact',
  SUMMARY: 'summary'
});

const MEMORY_SCOPE = Object.freeze({
  USER: 'user',
  SESSION: 'session',
  GLOBAL: 'global'
});

module.exports = {
  V2_DEFAULTS,
  SAFETY_ACTION,
  SAFETY_CATEGORY,
  MEMORY_KIND,
  MEMORY_SCOPE
};
