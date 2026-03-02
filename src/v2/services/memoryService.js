const { V2_DEFAULTS, MEMORY_KIND, MEMORY_SCOPE } = require('../constants');
const { generateId, nowIso, pickLanguage } = require('../utils');
const { upsertDoc, listDocs } = require('./storage');

const REFUSAL_POLLUTION = /(无法处理|不能协助|请求被策略拦截|I can't assist|policy blocked|无法继续该请求)/i;

function contextPartition(userId, contextId) {
  return `conv:${userId}:${contextId}`;
}

function memoryPartition(userId) {
  return `mem:${userId}`;
}

function stableFactCandidates(content) {
  const out = [];
  const text = String(content || '');

  const city = text.match(/(?:我在|在|来自)(北京|上海|广州|深圳|武汉|杭州|成都|西安|南京|重庆|天津|苏州|长沙)/);
  if (city) {
    out.push({ kind: MEMORY_KIND.FACT, content: `user_city:${city[1]}`, score: 0.95 });
  }

  const pref = text.match(/(?:我喜欢|我偏好|我更喜欢)([^，。\n]{1,20})/);
  if (pref) {
    out.push({ kind: MEMORY_KIND.PREFERENCE, content: `user_preference:${pref[1].trim()}`, score: 0.8 });
  }

  return out;
}

function summarizeTurns(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return '';
  const recent = turns.slice(-V2_DEFAULTS.memory.summaryTriggerTurns);
  const lines = recent.map((x) => `${x.role}: ${String(x.content || '').slice(0, 120)}`);
  const text = lines.join('\n');
  if (text.length <= V2_DEFAULTS.memory.summaryMaxChars) return text;
  return `${text.slice(0, V2_DEFAULTS.memory.summaryMaxChars - 3)}...`;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

async function getContext(userId, contextId, context = null) {
  const partitionKey = contextPartition(userId, contextId);
  const docs = await listDocs('conversations', partitionKey, { limit: 50 }, context);
  const turns = docs
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((x) => ({ role: x.role, content: x.content, created_at: x.created_at }));

  const short = turns.slice(-V2_DEFAULTS.memory.shortHistoryTurns);
  const summary = turns.length >= V2_DEFAULTS.memory.summaryTriggerTurns
    ? summarizeTurns(turns)
    : '';

  return {
    turns,
    short,
    summary,
    lang: pickLanguage(short[short.length - 1]?.content || '')
  };
}

async function appendTurn(userId, contextId, role, content, metadata = {}, context = null) {
  const doc = {
    id: generateId('turn'),
    role,
    content,
    metadata,
    created_at: nowIso()
  };
  await upsertDoc('conversations', contextPartition(userId, contextId), doc, context);

  if (role === 'assistant' && REFUSAL_POLLUTION.test(content)) {
    return [];
  }

  if (role === 'user') {
    const facts = stableFactCandidates(content);
    const refs = [];
    for (const item of facts) {
      const mem = await writeMemory({
        userId,
        scope: MEMORY_SCOPE.USER,
        kind: item.kind,
        content: item.content,
        score: item.score
      }, context);
      refs.push(mem.id);
    }
    return refs;
  }

  return [];
}

async function writeMemory({ userId, scope = MEMORY_SCOPE.USER, kind = MEMORY_KIND.FACT, content, score = 0.7, ttlDays }, context = null) {
  const ttl = Number.isFinite(Number(ttlDays)) ? Number(ttlDays) : V2_DEFAULTS.memory.ttlDays;
  const doc = {
    id: generateId('mem'),
    user_id: userId,
    scope,
    kind,
    content,
    score,
    embedding: null,
    ttl_days: ttl,
    created_at: nowIso(),
    expire_at: new Date(Date.now() + ttl * 24 * 3600 * 1000).toISOString()
  };
  await upsertDoc('memory', memoryPartition(userId), doc, context);
  return doc;
}

async function searchMemory(userId, query, limit = V2_DEFAULTS.memory.searchTopK, context = null) {
  const docs = await listDocs('memory', memoryPartition(userId), { limit: 300 }, context);
  const qTokens = tokenize(query);
  const now = Date.now();

  const scored = docs
    .filter((x) => !x.expire_at || new Date(x.expire_at).getTime() > now)
    .map((x) => {
      const sim = jaccard(qTokens, tokenize(x.content));
      const recencyBoost = Math.max(0, 1 - ((now - new Date(x.created_at).getTime()) / (15 * 24 * 3600 * 1000)));
      const kindBoost = x.kind === MEMORY_KIND.PREFERENCE ? 0.08 : x.kind === MEMORY_KIND.FACT ? 0.05 : 0;
      const score = 0.7 * sim + 0.2 * recencyBoost + 0.1 * kindBoost;
      return { ...x, similarity: sim, rank_score: score };
    })
    .filter((x) => x.rank_score >= V2_DEFAULTS.memory.similarityThreshold / 2)
    .sort((a, b) => b.rank_score - a.rank_score)
    .slice(0, Math.max(1, limit));

  return scored;
}

async function manualWrite(payload, context = null) {
  const userId = String(payload.user_id || '').trim();
  if (!userId) throw new Error('user_id is required');
  if (!Object.values(MEMORY_SCOPE).includes(payload.scope)) throw new Error('invalid scope');
  if (!Object.values(MEMORY_KIND).includes(payload.kind)) throw new Error('invalid kind');
  const content = String(payload.content || '').trim();
  if (!content) throw new Error('content is required');

  return writeMemory({
    userId,
    scope: payload.scope,
    kind: payload.kind,
    content,
    score: Number(payload.score) || 0.7,
    ttlDays: payload.ttl
  }, context);
}

module.exports = {
  getContext,
  appendTurn,
  writeMemory,
  searchMemory,
  manualWrite
};
