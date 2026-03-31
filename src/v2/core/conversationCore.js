const { detectSafetyDecision, buildRefusalMessage, buildDegradeMessage, maybeWrapDegrade } = require('./safety');
const { buildConversationContext, buildLLMMessages } = require('./contextManager');
const { executeSkill } = require('../services/skillRuntime');
const { writeUserLongTermMemories } = require('../services/memoryService');
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
const { planKnowledgeMode, shouldSkipSearch, formatSearchContext } = require('./knowledgeRouter');

// 新模块：ChatContext + Transcript + Compaction + Tool Pruning
const {
  buildSessionKey,
  createChatContext,
  appendUserTurn,
  appendAssistantTurn,
  appendToolCall,
  appendToolResult,
  shouldCompact
} = require('./sessionManager');
const { computeCompactionWindow, generateCompactionSummary, compactTranscript } = require('./compactionService');
const {
  addToolResult,
  updateToolResults,
  pruneExpiredToolResults,
  pruneDuplicateToolResults,
  getActiveToolResults
} = require('./toolResultManager');
const { loadChatContext, saveChatContext } = require('../services/chatContextStorage');

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

  // === 1. Session 管理 ===
  const sessionKey = buildSessionKey(messageReq);
  let chatContext = null;
  if (sessionKey) {
    try {
      chatContext = await loadChatContext(sessionKey, context);
    } catch (err) {
      context?.log?.(`[v2/session] load failed: ${err.message}`);
      chatContext = null;
    }
  }
  
  if (sessionKey && !chatContext) {
    chatContext = createChatContext(sessionKey, messageReq);
  }

  const persistChatContext = async () => {
    if (!sessionKey || !chatContext) return;
    try {
      await saveChatContext(sessionKey, chatContext, context);
    } catch (err) {
      context?.log?.(`[v2/session] save failed: ${err.message}`);
    }
  };

  const parsedOverlay = parseOverlayFromText(messageReq.content);
  const metadataOverlay = messageReq?.metadata?.roleplay_overlay || null;
  const roleplayOverlay = mergeOverlay(metadataOverlay, parsedOverlay);
  
  // === 2. Identity/Meta 优先判定 ===
  const identityMeta = resolveIdentityMetaReply(messageReq.content, {
    memoryEnabled: isLongMemoryEnabled(),
    allowPromptDetail: false
  });
  
  // === 3. 知识路由 ===
  const knowledgeMode = planKnowledgeMode(messageReq.content, {});
  
  const preCapabilityPlan = planCapabilities(messageReq);

  // === 4. 安全检测 ===
  const safetyDecision = detectSafetyDecision(messageReq.content);
  
  // === 5. 添加用户 Turn 到 Transcript ===
  if (chatContext) {
    appendUserTurn(chatContext, messageReq.content, {
      request_id: messageReq.request_id,
      channel: messageReq.channel,
      roleplay_overlay: roleplayOverlay || null
    });
    
    // 更新工具结果生命周期（每个用户回合递减）
    updateToolResults(chatContext);
  }

  const userMemoryWriteIds = await writeUserLongTermMemories(
    messageReq.user_id,
    messageReq.content,
    buildUserTurnMetadata(messageReq, roleplayOverlay),
    context
  );

  if (safetyDecision.action === SAFETY_ACTION.REFUSE) {
    const content = buildRefusalMessage(safetyDecision, lang);
    
    // 写入 Transcript
    if (chatContext) {
      appendAssistantTurn(chatContext, content, {
        request_id: messageReq.request_id,
        safety: safetyDecision,
        reply_mode: 'safety'
      });
      await persistChatContext();
    }
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
    
    // 写入 Transcript
    if (chatContext) {
      appendAssistantTurn(chatContext, content, {
        request_id: messageReq.request_id,
        safety: effectiveSafety,
        reply_mode: 'safety'
      });
      await persistChatContext();
    }
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

  const builtContext = await buildConversationContext(messageReq, context, {
    transcript: Array.isArray(chatContext?.transcript) ? chatContext.transcript : []
  });

  if (chatContext) {
    builtContext.compactionSummary = String(builtContext?.history?.summary || '').trim();
    builtContext.activeToolResults = getActiveToolResults(chatContext);
  }

  const activeOverlay = resolveActiveOverlay(builtContext?.history?.short || builtContext?.history?.turns || [], roleplayOverlay);
  builtContext.active_overlay = activeOverlay || null;

  const capabilityPlan = preCapabilityPlan;
  const responsePolicy = inferResponsePolicy(messageReq);
  const promptProfile = resolvePromptProfile(messageReq, capabilityPlan, knowledgeMode);
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

  // 知识路由：自动先搜索
  let searchResult = null;
  let searchContext = '';
  if (knowledgeMode.mode === 'search_first' && !shouldSkipSearch(messageReq) && replyMode !== 'identity_meta') {
    try {
      const searchSkill = await executeSkill('search.hybrid_search', {
        query: messageReq.content,
        maxResults: 3,
        search_mode: 'search_first'
      }, context);
      
      if (searchSkill.status === 'success') {
        searchResult = searchSkill;
        searchContext = formatSearchContext(searchSkill);
        if (searchContext) {
          replyMode = 'search_first';
          context?.log?.(`[v2/knowledge] search_first hit: ${knowledgeMode.reason}`);
          
          // 添加搜索结果到工具结果管理
          if (chatContext) {
            addToolResult(chatContext, 'search.hybrid_search', searchResult.output, {
              summary: searchContext.substring(0, 200),
              sourceTurnId: chatContext.transcript.length,
              expiresAfterTurns: 2,
              scope: 'question_and_followup'
            });
          }
        }
      }
    } catch (err) {
      context?.log?.(`[v2/knowledge] search failed, fallback to chat: ${err.message}`);
    }
  }

  let toolCalls = [];
  if (replyMode === 'search_first') {
    toolCalls = searchResult ? [searchResult] : [];
  } else if (replyMode !== 'identity_meta') {
    toolCalls = await executeCapabilityPlan(messageReq, capabilityPlan, context);
  }
  
  // 添加工具调用和结果到 Transcript
  if (chatContext && toolCalls.length > 0) {
    for (const call of toolCalls) {
      appendToolCall(chatContext, call.tool, call.input || {}, {
        status: call.status
      });
      
      if (call.status === 'success' && call.output) {
        const toolResultEntryId = appendToolResult(chatContext, call.tool, call.output, {
          status: call.status,
          source_turn_id: chatContext.transcript[chatContext.transcript.length - 1]?.id || null,
          error: call.error || null
        });
        
        // 添加到工具结果管理器
        addToolResult(chatContext, call.tool, call.output, {
          summary: toolOutputToText(call, messageReq).substring(0, 200),
          sourceTurnId: toolResultEntryId,
          expiresAfterTurns: call.tool === 'draw.generate_image' ? 1 : 2,
          scope: call.tool === 'draw.generate_image' ? 'current_turn' : 'question_and_followup'
        });
      }
    }
  }

  if (capabilityPlan.mode === 'capability' && replyMode !== 'identity_meta') {
    replyMode = 'capability';
  }

  const persona = resolvePersona(messageReq, effectiveSafety, emotionState);

  let content = replyMode === 'identity_meta'
    ? identityMeta.reply
    : (replyMode === 'search_first' ? '' : extractToolMessage(toolCalls));

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
      sceneSkeleton,
      searchContext,
      {
        activeToolResults: builtContext.activeToolResults || [],
        compactionSummary: builtContext.compactionSummary || ''
      }
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

  // === 添加 Assistant Turn 到 Transcript ===
  if (chatContext) {
    appendAssistantTurn(chatContext, content, {
      request_id: messageReq.request_id,
      safety: effectiveSafety,
      reply_mode: replyMode,
      model
    });
    
    // 清理过期的工具结果
    pruneExpiredToolResults(chatContext);
    pruneDuplicateToolResults(chatContext);
    
    // === Compaction 检查 ===
    const compactWindow = computeCompactionWindow(chatContext.transcript || [], {
      keepRecent: 8,
      previousKeptFromTurn: Number(chatContext?.compaction_meta?.kept_from_turn || 0)
    });

    if (
      shouldCompact(chatContext, { maxEntries: 24, maxTokens: 12000 })
      && compactWindow.sourceTurnCount > 0
      && compactWindow.toTurn > compactWindow.fromTurn
    ) {
      context?.log?.('[v2/compaction] triggering compaction');
      try {
        const segment = chatContext.transcript.slice(compactWindow.fromTurn, compactWindow.toTurn);
        const summary = await generateCompactionSummary(segment, context);
        compactTranscript(chatContext, summary, {
          keepRecent: 8,
          fromTurn: compactWindow.fromTurn,
          toTurn: compactWindow.toTurn,
          sourceTurnCount: compactWindow.sourceTurnCount,
          previousKeptFromTurn: Number(chatContext?.compaction_meta?.kept_from_turn || 0)
        });
        context?.log?.(`[v2/compaction] compacted_range=${compactWindow.fromTurn}-${compactWindow.toTurn} turns=${compactWindow.sourceTurnCount}`);
      } catch (err) {
        context?.log?.(`[v2/compaction] failed: ${err.message}`);
      }
    }
    
    // === 保存 ChatContext ===
    await persistChatContext();
  }

  const memoryWriteIds = [...userMemoryWriteIds];

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
      search_used: !!searchContext,
      knowledge_mode: knowledgeMode.mode,
      memory_hits: Array.isArray(builtContext?.memory) ? builtContext.memory.length : 0,
      overlay_applied: !!overlayResult.overlayApplied,
      memory_write_ids: memoryWriteIds,
      compaction_used: chatContext?.compaction_meta?.compaction_count > 0,
      transcript_entry_count: chatContext?.transcript?.length || 0,
      active_tool_results: chatContext ? getActiveToolResults(chatContext).length : 0,
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
