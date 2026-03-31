const { searchMemory } = require('../services/memoryService');
const { selectSceneSkeleton } = require('./sceneSkeletonRegistry');
const { buildRuntimeContext } = require('./runtimeContextBuilder');
const { pickLanguage } = require('../utils');

function buildResponseStyleLine(responsePolicy = null) {
  const mode = String(responsePolicy?.mode || 'brief').toLowerCase();

  if (mode === 'professional') {
    return '回答策略：这是专业问题（如编码、数学、工程技术），请给出完整、严谨、可执行的详细回答，必要时包含步骤、推导与示例。';
  }

  if (mode === 'detailed') {
    return '回答策略：用户明确要求展开，请给出结构化的详细回答，但保持重点清晰。';
  }

  return '回答策略：若问题不属于专业任务，优先简要直答（1-3句）；除非用户继续追问或明确要求展开，再补充细节。';
}

function buildRecentStyleSummary(historyTurns = []) {
  const assistantTurns = (Array.isArray(historyTurns) ? historyTurns : [])
    .filter((x) => String(x?.role || '').toLowerCase() === 'assistant')
    .slice(-3)
    .map((x) => String(x?.content || '').trim())
    .filter(Boolean);

  if (!assistantTurns.length) return '';

  const avgLen = assistantTurns.reduce((sum, x) => sum + x.length, 0) / assistantTurns.length;
  const prefixCount = assistantTurns.filter((x) => /^(（|\(|\[)/.test(x)).length;
  const askCount = assistantTurns.filter((x) => /[？?]/.test(x)).length;
  const tone = avgLen >= 120 ? '偏详细' : avgLen >= 60 ? '中等' : '偏简洁';

  return `最近3轮风格摘要：回复${tone}；动作前缀 ${prefixCount}/${assistantTurns.length}；追问收尾 ${askCount}/${assistantTurns.length}。保持自然变化，避免复读。`;
}

function buildSceneHint(req = {}, responsePolicy = null, sceneSkeleton = null, builtContext = null) {
  const selected = sceneSkeleton || selectSceneSkeleton(req, {
    responsePolicy,
    historyTurns: builtContext?.history?.short || []
  });

  if (!selected?.systemHint) return '';
  return `场景骨架：${selected.systemHint}`;
}

function buildOverlayHint(activeOverlay = null) {
  if (!activeOverlay || typeof activeOverlay !== 'object') return '';

  const rules = [];
  if (activeOverlay.noPunctuation) rules.push('按用户要求，本轮尽量不加标点。');
  if (activeOverlay.oneLine) rules.push('按用户要求，尽量单行短句回答。');
  if (activeOverlay.address) rules.push(`优先使用用户要求的称呼：${activeOverlay.address}。`);
  if (activeOverlay.exactReply && activeOverlay.justTriggered) {
    rules.push(`本轮可一次性跟读指定短句：“${activeOverlay.exactReply}”。`);
  }

  if (!rules.length) return '';
  return `临时角色跟随（短生命周期）：\n- ${rules.join('\n- ')}`;
}

function buildActiveToolResultHint(activeToolResults = []) {
  const items = Array.isArray(activeToolResults) ? activeToolResults : [];
  if (!items.length) return '';

  const lines = items
    .slice(-4)
    .map((x) => `- ${x.tool}: ${String(x.summary || '').trim()}`)
    .filter((x) => x.length > 4);

  if (!lines.length) return '';
  return `近期工具结果摘要：\n${lines.join('\n')}`;
}

function buildHistoryFromTranscript(transcript = [], req = {}) {
  const rows = Array.isArray(transcript) ? transcript : [];
  const turns = rows
    .filter((x) => x?.type === 'user' || x?.type === 'assistant')
    .map((x) => ({
      role: x.type,
      content: String(x.content || '').trim(),
      created_at: x.created_at,
      metadata: x.metadata || {}
    }))
    .filter((x) => x.content);

  const latestCompaction = [...rows].reverse().find((x) => x?.type === 'compaction');
  const summary = String(latestCompaction?.summary || latestCompaction?.content || '').trim();
  const short = turns.slice(-8);

  return {
    turns,
    short,
    summary,
    lang: pickLanguage(short[short.length - 1]?.content || req?.content || '')
  };
}

async function buildConversationContext(req, context = null, options = {}) {
  const transcript = Array.isArray(options?.transcript) ? options.transcript : [];
  const [memoryHits] = await Promise.all([
    searchMemory(req.user_id, req.content, 4, context)
  ]);

  const historyBundle = buildHistoryFromTranscript(transcript, req);

  return {
    history: historyBundle,
    memory: memoryHits,
    memoryRefs: memoryHits.map((x) => x.id)
  };
}

function buildLLMMessages(req, builtContext, toolCalls, promptProfile = null, emotionAddition = '', responsePolicy = null, sceneSkeleton = null, searchContext = '', runtimeHints = {}) {
  const runtimeContext = buildRuntimeContext(req, builtContext);
  const memoryLines = (builtContext.memory || []).map((m) => `- ${m.kind}: ${m.content}`).join('\n');
  const toolLines = (toolCalls || [])
    .filter((x) => x.status === 'success' && x.output)
    .map((x) => `- ${x.tool}: ${typeof x.output === 'string' ? x.output : (x.output.message || JSON.stringify(x.output))}`)
    .join('\n');
  const responseStyleLine = buildResponseStyleLine(responsePolicy);
  const recentStyleSummary = buildRecentStyleSummary(builtContext?.history?.short || []);
  const sceneHint = buildSceneHint(req, responsePolicy, sceneSkeleton, builtContext);
  const overlayHint = buildOverlayHint(builtContext?.active_overlay || null);
  const activeToolHint = buildActiveToolResultHint(runtimeHints?.activeToolResults || builtContext?.activeToolResults || []);
  const compactionSummary = String(runtimeHints?.compactionSummary || builtContext?.compactionSummary || '').trim();

  const system = [
    promptProfile?.system || '你是天童爱丽丝，当前定位是情感陪伴型对话。回复要自然、温柔、可理解。',
    '约束：禁止编造数据；不确定就明确说缺口。',
    '约束：如果工具结果或搜索结果存在，优先基于它们回答，但要用爱丽丝的语气转述，不要生硬复制。',
    runtimeContext,
    responseStyleLine,
    sceneHint,
    overlayHint,
    recentStyleSummary,
    compactionSummary ? `会话压缩摘要：\n${compactionSummary}` : '',
    activeToolHint,
    emotionAddition ? `表达增强:\n${emotionAddition}` : '',
    memoryLines ? `用户记忆:\n${memoryLines}` : '',
    searchContext ? searchContext : '',
    toolLines ? `工具结果:\n${toolLines}` : ''
  ].filter(Boolean).join('\n\n');

  const history = builtContext.history.short || [];
  const messages = [{ role: 'system', content: system }];

  for (const item of history) {
    messages.push({ role: item.role, content: item.content });
  }

  messages.push({ role: 'user', content: req.content });
  return messages;
}

module.exports = {
  buildConversationContext,
  buildHistoryFromTranscript,
  buildLLMMessages,
  buildResponseStyleLine,
  buildRecentStyleSummary,
  buildSceneHint,
  buildOverlayHint,
  buildActiveToolResultHint
};
