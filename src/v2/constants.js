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
      audit: process.env.V2_AUDIT_CONTAINER || 'AuditV2'
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
  ACADEMIC_INTEGRITY: 'academic_integrity',
  DATA_PRIVACY: 'data_privacy',
  HIGH_RISK: 'high_risk',
  HARMFUL: 'harmful',
  PROMPT_INJECTION: 'prompt_injection',
  DECISION_MAKING: 'decision_making'
});

const MEMORY_KIND = Object.freeze({
  PROFILE: 'profile',
  PREFERENCE: 'preference',
  RELATIONSHIP: 'relationship',
  EXPLICIT_NOTE: 'explicit_note',
  ONGOING_TOPIC: 'ongoing_topic',
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
