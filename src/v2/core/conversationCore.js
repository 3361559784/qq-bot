const { detectSafetyDecision, buildRefusalMessage, buildDegradeMessage, maybeWrapDegrade } = require('./safety');
const { buildConversationContext, buildLLMMessages } = require('./contextManager');
const { planAndExecute } = require('../services/skillRuntime');
const { appendTurn } = require('../services/memoryService');
const { chatWithFallback } = require('../services/llmService');
const { logAudit } = require('../services/auditService');
const { generateId, nowIso, pickLanguage } = require('../utils');
const { SAFETY_ACTION } = require('../constants');

function createUsageZero() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

const GENERIC_FALLBACK_ZH = '我收到了你的消息。你可以更具体告诉我你想查什么（课表/天气/搜索/任务）。';

function extractToolMessage(toolCalls) {
  for (const call of toolCalls) {
    if (call.status !== 'success') continue;
    const out = call.output;
    if (typeof out === 'string' && out.trim()) return out.trim();
    if (out && typeof out.message === 'string' && out.message.trim()) return out.message.trim();
  }
  return '';
}

async function handleConversation(messageReq, context = null) {
  const startedAt = Date.now();
  const lang = pickLanguage(messageReq.content);

  const safety = detectSafetyDecision(messageReq.content);
  const responseId = generateId('msg');

  await appendTurn(
    messageReq.user_id,
    messageReq.context_id,
    'user',
    messageReq.content,
    { request_id: messageReq.request_id, channel: messageReq.channel },
    context
  );

  if (safety.action === SAFETY_ACTION.REFUSE) {
    const content = buildRefusalMessage(safety, lang);
    await appendTurn(
      messageReq.user_id,
      messageReq.context_id,
      'assistant',
      content,
      { request_id: messageReq.request_id, safety },
      context
    );

    const res = {
      id: responseId,
      content,
      persona: 'professional',
      tool_calls: [],
      safety,
      memory_refs: [],
      usage: createUsageZero(),
      latency_ms: Date.now() - startedAt,
      meta: {
        request_id: messageReq.request_id,
        channel: messageReq.channel,
        stage: 'safety_refuse',
        created_at: nowIso()
      }
    };

    await logAudit('v2.message.refused', {
      request_id: messageReq.request_id,
      user_id: messageReq.user_id,
      channel: messageReq.channel,
      safety_action: safety.action,
      reason_code: safety.reason_code,
      latency_ms: res.latency_ms
    }, context);

    return res;
  }

  if (safety.action === SAFETY_ACTION.DEGRADE && safety.strategy === 'clarify_first') {
    const content = buildDegradeMessage(safety, lang);
    await appendTurn(
      messageReq.user_id,
      messageReq.context_id,
      'assistant',
      content,
      { request_id: messageReq.request_id, safety },
      context
    );

    const res = {
      id: responseId,
      content,
      persona: 'professional',
      tool_calls: [],
      safety,
      memory_refs: [],
      usage: createUsageZero(),
      latency_ms: Date.now() - startedAt,
      meta: {
        request_id: messageReq.request_id,
        channel: messageReq.channel,
        stage: 'safety_clarify',
        created_at: nowIso()
      }
    };

    await logAudit('v2.message.clarify', {
      request_id: messageReq.request_id,
      user_id: messageReq.user_id,
      channel: messageReq.channel,
      safety_action: safety.action,
      reason_code: safety.reason_code,
      latency_ms: res.latency_ms
    }, context);

    return res;
  }

  const builtContext = await buildConversationContext(messageReq, context);

  const toolExec = await planAndExecute(messageReq.content, messageReq.metadata || {}, context);
  const toolCalls = toolExec.calls || [];
  let content = extractToolMessage(toolCalls);
  let usage = createUsageZero();
  let model = 'tool_only';

  if (!content) {
    const messages = buildLLMMessages(messageReq, builtContext, toolCalls);
    const llm = await chatWithFallback(messages, {}, context);
    content = llm.content || GENERIC_FALLBACK_ZH;
    usage = llm.usage || usage;
    model = llm.model || 'unknown';
  }

  if (safety.action === SAFETY_ACTION.DEGRADE) {
    if (content === GENERIC_FALLBACK_ZH) {
      content = '';
    }
    content = maybeWrapDegrade(content, safety, lang);
  }

  const newMemoryRefs = await appendTurn(
    messageReq.user_id,
    messageReq.context_id,
    'assistant',
    content,
    {
      request_id: messageReq.request_id,
      safety,
      tool_calls: toolCalls.map((x) => ({ tool: x.tool, status: x.status, error: x.error || null })),
      model
    },
    context
  );

  const response = {
    id: responseId,
    content,
    persona: 'professional',
    tool_calls: toolCalls,
    safety,
    memory_refs: [...(builtContext.memoryRefs || []), ...(newMemoryRefs || [])],
    usage,
    latency_ms: Date.now() - startedAt,
    meta: {
      request_id: messageReq.request_id,
      channel: messageReq.channel,
      model,
      stage: 'completed',
      created_at: nowIso()
    }
  };

  await logAudit('v2.message.completed', {
    request_id: messageReq.request_id,
    user_id: messageReq.user_id,
    channel: messageReq.channel,
    safety_action: safety.action,
    reason_code: safety.reason_code,
    tools_used: toolCalls.map((x) => x.tool),
    latency_ms: response.latency_ms
  }, context);

  return response;
}

module.exports = {
  handleConversation
};
