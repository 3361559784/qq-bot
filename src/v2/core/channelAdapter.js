const { generateId, trimContent } = require('../utils');
const { V2_DEFAULTS } = require('../constants');

function normalizeMessageRequest(body = {}, request = null) {
  const fromLegacyQq = body?.post_type === 'message';

  const content = fromLegacyQq
    ? String(body.raw_message || body.message || '').trim()
    : String(body.content || body.message || '').trim();

  const userId = fromLegacyQq
    ? String(body.user_id || body.sender?.user_id || body.sender?.id || 'unknown')
    : String(body.user_id || body.sessionId || 'web_unknown');

  const channel = fromLegacyQq
    ? 'qq'
    : String(body.channel || body.client || 'web').toLowerCase();

  const contextId = String(body.context_id || body.sessionId || `${channel}_${userId}`);
  const requestId = String(body.request_id || body.requestId || request?.headers?.get?.('x-request-id') || generateId('req'));

  const attachments = Array.isArray(body.attachments)
    ? body.attachments.slice(0, V2_DEFAULTS.limits.maxAttachments)
    : [];

  const metadata = {
    ...body.metadata,
    legacy: fromLegacyQq,
    schedule: Array.isArray(body.schedule) ? body.schedule : undefined,
    image_url: body.image_url || body.imageUrl || undefined,
    mode: body.mode,
    request_id: requestId
  };

  return {
    content: trimContent(content, V2_DEFAULTS.limits.maxContentChars),
    channel,
    user_id: userId,
    context_id: contextId,
    attachments,
    metadata,
    request_id: requestId
  };
}

function normalizeMessageResponse(response) {
  return {
    id: response.id,
    content: response.content,
    persona: response.persona || 'professional',
    tool_calls: Array.isArray(response.tool_calls) ? response.tool_calls : [],
    safety: response.safety,
    memory_refs: Array.isArray(response.memory_refs) ? response.memory_refs : [],
    usage: response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    latency_ms: Number(response.latency_ms || 0),
    meta: response.meta || {}
  };
}

module.exports = {
  normalizeMessageRequest,
  normalizeMessageResponse
};
