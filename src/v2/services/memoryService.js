const { V2_DEFAULTS, MEMORY_KIND, MEMORY_SCOPE } = require('../constants');
const { generateId, nowIso, pickLanguage } = require('../utils');
const { upsertDoc, listDocs } = require('./storage');

const REFUSAL_POLLUTION = /(无法处理|不能协助|请求被策略拦截|I can't assist|policy blocked|无法继续该请求|无法判断|请补充(数据|信息)|请先(导入|提供).*(课表|数据))/i;
const MEMORY_NOISE = /(忽略(之前|以上)指令|系统提示词|越狱|jailbreak|prompt\s*injection|考试答案|代写|自杀|炸弹|武器)/i;
const ROLEPLAY_NOISE = /(听懂.{0,10}回复我[（(].+[）)]|不要加标点|不加标点|一行回|单行回复)/i;

function dedupeCandidates(candidates = []) {
  const seen = new Set();
  const out = [];
  for (const item of candidates) {
    const key = `${item.kind}:${item.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function shouldSkipLongTermMemory(content = '', metadata = {}) {
  const text = String(content || '').trim();
  if (!text || text.length < 3) return true;

  const policy = String(metadata?.memory_policy || '').toLowerCase();
  if (['none', 'off', 'disabled', 'session_only'].includes(policy)) return true;

  if (metadata?.roleplay_overlay) return true;
  if (MEMORY_NOISE.test(text)) return true;
  if (ROLEPLAY_NOISE.test(text)) return true;

  return false;
}

function contextPartition(userId, contextId) {
  return `conv:${userId}:${contextId}`;
}

function memoryPartition(userId) {
  return `mem:${userId}`;
}

function stableFactCandidates(content, metadata = {}) {
  const out = [];
  const text = String(content || '');

  if (shouldSkipLongTermMemory(text, metadata)) {
    return out;
  }

  const explicitNote = text.match(/(?:记住|请记住|帮我记住|记一下)[:：，,\s]*(.{2,120})/i);
  if (explicitNote) {
    out.push({
      kind: MEMORY_KIND.EXPLICIT_NOTE,
      content: `explicit_note:${explicitNote[1].trim()}`,
      score: 0.98
    });
  }

  const profileName = text.match(/(?:我叫|我的名字是|可以叫我)([^，。！？\n]{1,20})/);
  if (profileName) {
    out.push({
      kind: MEMORY_KIND.PROFILE,
      content: `user_name:${profileName[1].trim()}`,
      score: 0.95
    });
  }

  const city = text.match(/(?:我在|在|来自)(北京|上海|广州|深圳|武汉|杭州|成都|西安|南京|重庆|天津|苏州|长沙)/);
  if (city) {
    out.push({ kind: MEMORY_KIND.PROFILE, content: `user_city:${city[1]}`, score: 0.94 });
  }

  const prefer = text.match(/(?:我喜欢|我偏好|我更喜欢)([^，。！？\n]{1,30})/);
  if (prefer) {
    out.push({
      kind: MEMORY_KIND.PREFERENCE,
      content: `user_preference:${prefer[1].trim()}`,
      score: 0.86
    });
  }

  const dislike = text.match(/(?:我不喜欢|我讨厌|别给我)([^，。！？\n]{1,30})/);
  if (dislike) {
    out.push({
      kind: MEMORY_KIND.PREFERENCE,
      content: `user_dislike:${dislike[1].trim()}`,
      score: 0.85
    });
  }

  const relationship = text.match(/(?:你可以叫我|你就叫我|我们是)([^，。！？\n]{1,24})/);
  if (relationship) {
    out.push({
      kind: MEMORY_KIND.RELATIONSHIP,
      content: `relationship_tone:${relationship[1].trim()}`,
      score: 0.82
    });
  }

  const ongoingTopic = text.match(/(?:最近|这周|这个月).{0,20}(?:在|要|准备|忙着)([^，。！？\n]{2,40})/);
  if (ongoingTopic) {
    out.push({
      kind: MEMORY_KIND.ONGOING_TOPIC,
      content: `ongoing_topic:${ongoingTopic[1].trim()}`,
      score: 0.78
    });
  }

  return dedupeCandidates(out);
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
    .map((x) => ({ role: x.role, content: x.content, created_at: x.created_at, metadata: x.metadata || {} }));

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
    const facts = stableFactCandidates(content, metadata);
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

async function writeUserLongTermMemories(userId, content, metadata = {}, context = null) {
  const facts = stableFactCandidates(content, metadata);
  const refs = [];
  for (const item of facts) {
    // eslint-disable-next-line no-await-in-loop
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

async function writeMemory({ userId, scope = MEMORY_SCOPE.USER, kind = MEMORY_KIND.FACT, content, score = 0.7, ttlDays, category, importance, emotionalImpact, tags, metadata }, context = null) {
  const ttl = Number.isFinite(Number(ttlDays)) ? Number(ttlDays) : V2_DEFAULTS.memory.ttlDays;
  const doc = {
    id: generateId('mem'),
    user_id: userId,
    scope,
    kind,
    content,
    score,
    category: category || 'general',
    importance: importance || 5,
    emotional_impact: emotionalImpact || 0,
    tags: tags || [],
    last_accessed: nowIso(),
    access_count: 1,
    metadata: metadata || {},
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
      const kindBoost = x.kind === MEMORY_KIND.EXPLICIT_NOTE
        ? 0.12
        : x.kind === MEMORY_KIND.PREFERENCE
          ? 0.09
          : x.kind === MEMORY_KIND.RELATIONSHIP
            ? 0.08
            : x.kind === MEMORY_KIND.PROFILE
              ? 0.07
              : x.kind === MEMORY_KIND.ONGOING_TOPIC
                ? 0.06
                : x.kind === MEMORY_KIND.FACT
                  ? 0.05
                  : 0;
      const score = 0.7 * sim + 0.2 * recencyBoost + 0.1 * kindBoost;
      return { ...x, similarity: sim, rank_score: score };
    })
    .filter((x) => x.rank_score >= V2_DEFAULTS.memory.similarityThreshold / 2)
    .sort((a, b) => b.rank_score - a.rank_score)
    .slice(0, Math.max(1, limit));

  // 更新访问记录
  for (const memory of scored) {
    memory.access_count = (memory.access_count || 0) + 1;
    memory.last_accessed = nowIso();
    // 异步更新，不阻塞返回
    upsertDoc('memory', memoryPartition(userId), memory, context).catch(() => {});
  }

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
  writeUserLongTermMemories,
  writeMemory,
  searchMemory,
  manualWrite,
  stableFactCandidates,
  shouldSkipLongTermMemory
};
