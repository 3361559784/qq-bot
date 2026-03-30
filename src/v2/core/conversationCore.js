const { detectSafetyDecision, buildRefusalMessage, buildDegradeMessage, maybeWrapDegrade } = require('./safety');
const { buildConversationContext, buildLLMMessages } = require('./contextManager');
const { executeSkill } = require('../services/skillRuntime');
const { appendTurn } = require('../services/memoryService');
const { chatWithFallback } = require('../services/llmService');
const { logAudit } = require('../services/auditService');
const { generateId, nowIso, pickLanguage } = require('../utils');
const { SAFETY_ACTION } = require('../constants');
const { resolvePromptProfile } = require('./promptRegistry');
const { planCapabilities, parseLocation } = require('./capabilityPlanner');
const { detectAdvancedEmotion, getEmotionPromptAddition } = require('../../../services/emotionService');
const { pickFirstResolvedImageUrl } = require('./qqMediaResolver');
const { resolveIdentityMetaReply } = require('./identityMetaResolver');
const {
  parseOverlayFromText,
  mergeOverlay,
  resolveActiveOverlay,
  applyOverlayToReply
} = require('./roleplayOverlay');
const {
  applyAliceCompanionGuards,
  detectConversationScenario,
  structureReplyByScenario
} = require('./styleGuards');
const { selectSceneSkeleton } = require('./sceneSkeletonRegistry');
const { computeRelationshipDeltaState } = require('./relationshipStateMachine');

function createUsageZero() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

const GENERIC_FALLBACK_ZH = '机体状态正常。由于当前线索较少……可以请老师补充一点细节吗？爱丽丝想和老师一起把这段对话聊清楚。';

const LEGACY_REFUSAL_TEMPLATE = /【原因标签：|我能提供的替代帮助：|我不确定的地方：|如果要继续：/;

const CAPABILITY_TO_SKILL = Object.freeze({
  weather: 'weather.get_weather',
  search: 'search.hybrid_search',
  vision: 'vision.describe_image',
  draw: 'draw.generate_image',
  schedule: 'schedule.query',
  ocr: 'ocr.parse_schedule'
});

const PROFESSIONAL_QUERY_PATTERNS = [
  /```[\s\S]*?```/,
  /\b(def|class|function|interface|import|export|select|insert|update|delete|from|where|join|group\s+by)\b/i,
  /(编程|代码|写代码|脚本|函数|调试|报错|异常|bug|算法|复杂度|接口|数据库|sql|正则|前端|后端|部署|架构|单元测试|测试用例|python|javascript|typescript|java|c\+\+|c#|go|rust|node|npm|git|docker|k8s|linux)/i,
  /(数学|方程|定理|证明|推导|微积分|线性代数|概率论|统计学|图论|离散数学|导数|积分|矩阵|极限|梯度|最优化|傅里叶|拉普拉斯|数论)/i,
  /\b(algorithm|coding|programming|debug|refactor|runtime|stack\s*trace|exception|calculus|matrix|proof|derivative|integral|equation)\b/i,
  /[∑∫√π∞≤≥≈≠]/
];

const FORCE_BRIEF_PATTERNS = [
  /(简短|简要|一句话|只要结论|tl;?dr|精简|长话短说)/i
];

const FORCE_DETAIL_PATTERNS = [
  /(详细|展开讲|一步一步|完整推导|深度分析|请细讲|具体一点)/i
];

function inferResponsePolicy(req = {}) {
  const text = String(req?.content || '').trim();
  if (!text) {
    return { mode: 'brief', isProfessional: false };
  }

  if (FORCE_BRIEF_PATTERNS.some((re) => re.test(text))) {
    return { mode: 'brief', isProfessional: false };
  }

  if (PROFESSIONAL_QUERY_PATTERNS.some((re) => re.test(text))) {
    return { mode: 'professional', isProfessional: true };
  }

  if (FORCE_DETAIL_PATTERNS.some((re) => re.test(text))) {
    return { mode: 'detailed', isProfessional: false };
  }

  return { mode: 'brief', isProfessional: false };
}

function inferAffectionLevel(turns = []) {
  const n = Array.isArray(turns) ? turns.length : 0;
  if (n >= 60) return 'close_friend';
  if (n >= 24) return 'friend';
  if (n >= 8) return 'acquaintance';
  return 'stranger';
}

function buildDeltaPromptAddition(deltaState = {}) {
  const hints = [];

  if (deltaState.idleWarning) {
    hints.push('互动状态：用户近期互动较少，先温柔问候再进入正题。');
  }

  if (deltaState.hasRecentPanicOrRude) {
    hints.push('互动状态：近期情绪有波动，语气保持稳定，减少夸张表达。');
  }

  if (deltaState.shouldAmplifyAffection) {
    hints.push('互动状态：关系稳定，可适度增加陪伴感和接纳感。');
  }

  if (!hints.length) return '';
  return `互动连续性提示：\n- ${hints.join('\n- ')}`;
}

function resolveEmotionState(req = {}, builtContext = null, options = {}) {
  const detection = detectAdvancedEmotion(String(req?.content || ''));
  const affectionLevel = inferAffectionLevel(builtContext?.history?.turns || []);
  const deltaState = computeRelationshipDeltaState({
    turns: builtContext?.history?.turns || [],
    requestContent: String(req?.content || ''),
    currentEmotion: detection,
    capabilityMode: options?.capabilityPlan?.mode || 'chat',
    responsePolicyMode: options?.responsePolicy?.mode || 'brief',
    effectiveSafety: options?.effectiveSafety || { action: 'pass' }
  });

  const promptAddition = [
    getEmotionPromptAddition(detection.response, affectionLevel),
    buildDeltaPromptAddition(deltaState)
  ].filter(Boolean).join('\n\n');

  return {
    ...detection,
    affectionLevel,
    deltaState,
    promptAddition
  };
}

function resolvePersona(req = {}, effectiveSafety = {}, emotionState = {}) {
  return 'alice';
}

function wasLeadUsedRecently(historyTurns = [], lead = '') {
  if (!lead) return false;
  const recent = (Array.isArray(historyTurns) ? historyTurns : [])
    .filter((x) => String(x?.role || '').toLowerCase() === 'assistant')
    .slice(-4)
    .map((x) => String(x?.content || '').trim());
  return recent.some((x) => x.startsWith(lead));
}

function stylizeContentByEmotion(content = '', persona = 'alice', emotionState = {}, historyTurns = []) {
  const text = String(content || '').trim();
  if (!text || persona !== 'alice') return text;
  if (/^\[CQ:image,/.test(text)) return text;
  if (/^(（|\(|\[)/.test(text)) return text;

  const leadMap = {
    happy: '（光环一亮）',
    playful: '（眨眨眼）',
    gentle: '（轻声）',
    caring: '（递上温水）',
    embarrassed_angry: '（脸有点红）',
    angry: '（鼓起脸）',
    panicked: '（有点慌）',
    serious: '（认真）'
  };

  const lead = leadMap[emotionState?.response] || '';
  if (lead && wasLeadUsedRecently(historyTurns, lead)) {
    return text;
  }
  return lead ? `${lead}${text}` : text;
}

async function firstImageUrl(req = {}, context = null) {
  const resolved = await pickFirstResolvedImageUrl(req, context);
  if (resolved) return resolved;

  const fallback = String(req?.metadata?.image_url || '').trim();
  if (/^https?:\/\//i.test(fallback)) return fallback;
  return '';
}

async function buildCapabilityInput(capability, req = {}, context = null) {
  const content = String(req.content || '').trim();
  const imageUrl = await firstImageUrl(req, context);
  const base = {
    query: content,
    prompt: content,
    location: parseLocation(content),
    attachments: req.attachments || [],
    image_url: imageUrl,
    schedule: req?.metadata?.schedule
  };

  if (capability === 'draw') {
    return {
      ...base,
      prompt: content
        .replace(/^(帮我|请|麻烦)?\s*(画|绘图|画图|生成图片|draw)\s*/i, '')
        .trim() || content
    };
  }

  if (capability === 'weather') {
    return {
      ...base,
      location: parseLocation(content)
    };
  }

  return base;
}

async function executeCapabilityPlan(req = {}, capabilityPlan = { mode: 'chat', capabilities: ['none'] }, context = null) {
  const capabilities = Array.isArray(capabilityPlan.capabilities) ? capabilityPlan.capabilities : [];
  if (capabilityPlan.mode !== 'capability' || !capabilities.length || capabilities.includes('none')) {
    return [];
  }

  const calls = [];
  for (const cap of capabilities) {
    const skillName = CAPABILITY_TO_SKILL[cap];
    if (!skillName) continue;
    // eslint-disable-next-line no-await-in-loop
    const skillInput = await buildCapabilityInput(cap, req, context);
    // eslint-disable-next-line no-await-in-loop
    const call = await executeSkill(skillName, skillInput, context);
    calls.push(call);
  }
  return calls;
}

function sanitizeAssistantReply(text = '') {
  const content = String(text || '').trim();
  if (!content) return content;
  if (!LEGACY_REFUSAL_TEMPLATE.test(content)) return content;
  return content
    .split('\n')
    .filter((line) => !/^(【原因标签：|为什么不能直接回答：|我能提供的替代帮助：|我不确定的地方：|如果要继续：)/.test(String(line || '').trim()))
    .join('\n')
    .trim();
}

function toolOutputToText(call = {}, req = {}) {
  const out = call?.output;
  if (!out) return '';

  if (call?.tool === 'draw.generate_image' && out?.image_url) {
    if (String(req.channel || '').toLowerCase() === 'qq') {
      return `[CQ:image,file=${out.image_url}]`;
    }
    return `已生成图片：${out.image_url}`;
  }

  if (typeof out === 'string' && out.trim()) return out.trim();
  if (out && typeof out.message === 'string' && out.message.trim()) return out.message.trim();
  return '';
}

function extractToolMessage(toolCalls) {
  for (const call of toolCalls) {
    if (call.status !== 'success') continue;
    const out = call.output;
    if (typeof out === 'string' && out.trim()) return out.trim();
    if (out && typeof out.message === 'string' && out.message.trim()) return out.message.trim();
  }
  return '';
}

function isLongMemoryEnabled() {
  const disabled = /^(1|true|yes|on)$/i.test(String(process.env.V2_DISABLE_LONG_MEMORY || '').trim());
  return !disabled;
}

function buildUserTurnMetadata(messageReq, roleplayOverlay = null) {
  return {
    request_id: messageReq.request_id,
    channel: messageReq.channel,
    trigger_source: messageReq?.metadata?.trigger_source || null,
    memory_policy: messageReq?.metadata?.memory_policy || null,
    roleplay_overlay: roleplayOverlay || null
  };
}

function createResponseBase({
  responseId,
  content,
  persona = 'alice',
  toolCalls = [],
  safety,
  memoryRefs = [],
  usage,
  startedAt,
  requestId,
  channel,
  meta = {}
} = {}) {
  return {
    id: responseId,
    content,
    persona,
    tool_calls: toolCalls,
    safety,
    memory_refs: memoryRefs,
    usage: usage || createUsageZero(),
    latency_ms: Date.now() - startedAt,
    meta: {
      request_id: requestId,
      channel,
      ...meta,
      created_at: nowIso()
    }
  };
}

async function handleConversation(messageReq, context = null) {
  const startedAt = Date.now();
  const lang = pickLanguage(messageReq.content);
  const responseId = generateId('msg');

  const parsedOverlay = parseOverlayFromText(messageReq.content);
  const metadataOverlay = messageReq?.metadata?.roleplay_overlay || null;
  const roleplayOverlay = mergeOverlay(metadataOverlay, parsedOverlay);
  const identityMeta = resolveIdentityMetaReply(messageReq.content, {
    memoryEnabled: isLongMemoryEnabled(),
    allowPromptDetail: false
  });
  const preCapabilityPlan = planCapabilities(messageReq);

  const safetyDecision = detectSafetyDecision(messageReq.content);

  const userMemoryWriteIds = await appendTurn(
    messageReq.user_id,
    messageReq.context_id,
    'user',
    messageReq.content,
    buildUserTurnMetadata(messageReq, roleplayOverlay),
    context
  );

  if (safetyDecision.action === SAFETY_ACTION.REFUSE) {
    const content = buildRefusalMessage(safetyDecision, lang);
    await appendTurn(
      messageReq.user_id,
      messageReq.context_id,
      'assistant',
      content,
      {
        request_id: messageReq.request_id,
        safety: safetyDecision,
        reply_mode: 'safety',
        overlay_applied: false,
        memory_write_ids: userMemoryWriteIds
      },
      context
    );

    const res = createResponseBase({
      responseId,
      content,
      safety: safetyDecision,
      memoryRefs: userMemoryWriteIds,
      startedAt,
      requestId: messageReq.request_id,
      channel: messageReq.channel,
      meta: {
        stage: 'safety_refuse',
        reply_mode: 'safety',
        overlay_applied: false,
        memory_write_ids: userMemoryWriteIds
      }
    });

    await logAudit('v2.message.refused', {
      request_id: messageReq.request_id,
      user_id: messageReq.user_id,
      channel: messageReq.channel,
      safety_action: safetyDecision.action,
      reason_code: safetyDecision.reason_code,
      latency_ms: res.latency_ms
    }, context);

    return res;
  }

  const lowConfidenceDegrade = safetyDecision.action === SAFETY_ACTION.DEGRADE && Number(safetyDecision.confidence || 0) < 0.6;
  if (lowConfidenceDegrade) {
    context?.log?.(`[v2/safety] low-confidence degrade log-only: ${safetyDecision.reason_code}`);
  }

  const effectiveSafety = lowConfidenceDegrade
    ? { ...safetyDecision, action: SAFETY_ACTION.PASS, reason_code: 'SAFETY_LOW_CONF_LOG_ONLY', original_reason_code: safetyDecision.reason_code }
    : safetyDecision;

  if (!lowConfidenceDegrade && effectiveSafety.action === SAFETY_ACTION.DEGRADE && effectiveSafety.strategy === 'clarify_first') {
    const content = buildDegradeMessage(effectiveSafety, lang);
    await appendTurn(
      messageReq.user_id,
      messageReq.context_id,
      'assistant',
      content,
      {
        request_id: messageReq.request_id,
        safety: effectiveSafety,
        reply_mode: 'safety',
        overlay_applied: false,
        memory_write_ids: userMemoryWriteIds
      },
      context
    );

    const res = createResponseBase({
      responseId,
      content,
      safety: effectiveSafety,
      memoryRefs: userMemoryWriteIds,
      startedAt,
      requestId: messageReq.request_id,
      channel: messageReq.channel,
      meta: {
        stage: 'safety_clarify',
        reply_mode: 'safety',
        overlay_applied: false,
        memory_write_ids: userMemoryWriteIds
      }
    });

    await logAudit('v2.message.clarify', {
      request_id: messageReq.request_id,
      user_id: messageReq.user_id,
      channel: messageReq.channel,
      safety_action: effectiveSafety.action,
      reason_code: effectiveSafety.reason_code,
      latency_ms: res.latency_ms
    }, context);

    return res;
  }

  const builtContext = await buildConversationContext(messageReq, context);
  const activeOverlay = resolveActiveOverlay(builtContext?.history?.turns || [], roleplayOverlay);
  builtContext.active_overlay = activeOverlay || null;

  const capabilityPlan = preCapabilityPlan;
  const responsePolicy = inferResponsePolicy(messageReq);
  const promptProfile = resolvePromptProfile(messageReq, capabilityPlan);
  const emotionState = resolveEmotionState(messageReq, builtContext, {
    capabilityPlan,
    responsePolicy,
    effectiveSafety
  });
  const sceneSkeleton = selectSceneSkeleton(messageReq, {
    capabilityPlan,
    responsePolicy,
    promptProfileName: promptProfile?.name || 'api_fallback',
    historyTurns: builtContext?.history?.short || []
  });

  const sceneContext = detectConversationScenario(messageReq, {
    sceneKey: sceneSkeleton?.key || '',
    promptProfileName: promptProfile?.name || 'api_fallback',
    capabilityMode: capabilityPlan?.mode || 'chat',
    responsePolicyMode: responsePolicy?.mode || 'brief',
    safetyAction: effectiveSafety?.action || SAFETY_ACTION.PASS
  });

  let replyMode = 'chat';

  if (identityMeta.matched) {
    replyMode = 'identity_meta';
  }

  const toolCalls = (replyMode === 'identity_meta')
    ? []
    : await executeCapabilityPlan(messageReq, capabilityPlan, context);

  if (capabilityPlan.mode === 'capability' && replyMode !== 'identity_meta') {
    replyMode = 'capability';
  }

  const persona = resolvePersona(messageReq, effectiveSafety, emotionState);

  let content = replyMode === 'identity_meta'
    ? identityMeta.reply
    : extractToolMessage(toolCalls);

  // draw 结果优先直接透传（QQ 需要 CQ image）
  if (!content && replyMode !== 'identity_meta' && toolCalls.length > 0) {
    const drawCall = toolCalls.find((x) => x.tool === 'draw.generate_image' && x.status === 'success');
    if (drawCall) {
      content = toolOutputToText(drawCall, messageReq);
    }
  }

  let usage = createUsageZero();
  let model = replyMode === 'identity_meta' ? 'identity_resolver' : 'tool_only';

  if (!content && activeOverlay?.exactReply && activeOverlay.justTriggered) {
    content = activeOverlay.exactReply;
    model = 'roleplay_overlay_exact';
  }

  if (!content && replyMode !== 'identity_meta') {
    const messages = buildLLMMessages(
      messageReq,
      builtContext,
      toolCalls,
      promptProfile,
      emotionState.promptAddition,
      responsePolicy,
      sceneSkeleton
    );
    const llm = await chatWithFallback(messages, {}, context);
    content = llm.content || GENERIC_FALLBACK_ZH;
    usage = llm.usage || usage;
    model = llm.model || 'unknown';
  }

  if (effectiveSafety.action === SAFETY_ACTION.DEGRADE) {
    if (content === GENERIC_FALLBACK_ZH) {
      content = '';
    }
    content = maybeWrapDegrade(content, effectiveSafety, lang);
  }

  content = sanitizeAssistantReply(content);

  const overlayResult = applyOverlayToReply(content, activeOverlay);
  content = overlayResult.content || content;

  if (!overlayResult.exactFormat) {
    content = stylizeContentByEmotion(content, persona, emotionState, builtContext?.history?.short || []);
  }

  content = structureReplyByScenario(content, {
    sceneContext,
    sceneSkeleton,
    historyTurns: builtContext?.history?.short || [],
    emotionResponse: emotionState.response,
    capabilityMode: capabilityPlan?.mode || 'chat',
    safetyAction: effectiveSafety?.action || SAFETY_ACTION.PASS,
    allowMetaTalk: promptProfile?.name === 'identity_meta' || replyMode === 'identity_meta',
    exactFormatReply: overlayResult.exactFormat
  });
  content = applyAliceCompanionGuards(content, {
    historyTurns: builtContext?.history?.short || [],
    emotionResponse: emotionState.response,
    allowMetaTalk: promptProfile?.name === 'identity_meta' || replyMode === 'identity_meta',
    capabilityMode: capabilityPlan?.mode || 'chat',
    safetyAction: effectiveSafety?.action || 'pass',
    exactFormatReply: overlayResult.exactFormat
  });

  const newMemoryRefs = await appendTurn(
    messageReq.user_id,
    messageReq.context_id,
    'assistant',
    content,
    {
      request_id: messageReq.request_id,
      safety: effectiveSafety,
      capability_plan: capabilityPlan,
      prompt_profile: promptProfile?.name || 'api_fallback',
      emotion: {
        type: emotionState.type,
        response: emotionState.response,
        affection_level: emotionState.affectionLevel,
        delta_state: emotionState.deltaState
      },
      scene_skeleton: sceneSkeleton ? { key: sceneSkeleton.key, variant_id: sceneSkeleton.variantId } : null,
      response_policy: responsePolicy.mode,
      reply_mode: replyMode,
      overlay_applied: !!overlayResult.overlayApplied,
      memory_write_ids: userMemoryWriteIds,
      tool_calls: toolCalls.map((x) => ({ tool: x.tool, status: x.status, error: x.error || null })),
      model
    },
    context
  );

  const memoryWriteIds = [...userMemoryWriteIds, ...(newMemoryRefs || [])];

  const response = {
    id: responseId,
    content,
    persona,
    tool_calls: toolCalls,
    safety: effectiveSafety,
    memory_refs: [...(builtContext.memoryRefs || []), ...memoryWriteIds],
    usage,
    latency_ms: Date.now() - startedAt,
    meta: {
      request_id: messageReq.request_id,
      channel: messageReq.channel,
      model,
      reply_mode: replyMode,
      overlay_applied: !!overlayResult.overlayApplied,
      memory_write_ids: memoryWriteIds,
      emotion: {
        type: emotionState.type,
        response: emotionState.response,
        affection_level: emotionState.affectionLevel,
        delta_state: emotionState.deltaState
      },
      prompt_profile: promptProfile?.name || 'api_fallback',
      scene_skeleton: sceneSkeleton ? { key: sceneSkeleton.key, variant_id: sceneSkeleton.variantId } : null,
      response_policy: responsePolicy.mode,
      capability_plan: capabilityPlan,
      active_overlay: activeOverlay ? {
        noPunctuation: !!activeOverlay.noPunctuation,
        oneLine: !!activeOverlay.oneLine,
        address: activeOverlay.address || null,
        justTriggered: !!activeOverlay.justTriggered,
        remainingUserTurns: Number(activeOverlay.remainingUserTurns || 0)
      } : null,
      stage: 'completed',
      created_at: nowIso()
    }
  };

  await logAudit('v2.message.completed', {
    request_id: messageReq.request_id,
    user_id: messageReq.user_id,
    channel: messageReq.channel,
    safety_action: effectiveSafety.action,
    reason_code: effectiveSafety.reason_code,
    tools_used: toolCalls.map((x) => x.tool),
    emotion_type: emotionState.type,
    emotion_response: emotionState.response,
    prompt_profile: promptProfile?.name || 'api_fallback',
    scene_key: sceneSkeleton?.key || null,
    response_policy: responsePolicy.mode,
    capability_mode: capabilityPlan?.mode || 'chat',
    reply_mode: replyMode,
    overlay_applied: !!overlayResult.overlayApplied,
    memory_write_count: memoryWriteIds.length,
    latency_ms: response.latency_ms
  }, context);

  return response;
}

module.exports = {
  handleConversation
};
