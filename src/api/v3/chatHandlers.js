const { normalizeMessageRequest, normalizeMessageResponse } = require('../../v2/core/channelAdapter');
const { handleConversation } = require('../../v2/core/conversationCore');
const { encodeSse } = require('../../v2/utils');
const { adaptV2ToLegacyHttp, parseHttpJsonBody } = require('../../functions/schoolbot/http/responseAdapter');
const { makeRequestLike } = require('./helpers');

function toLegacyShape(v2Response, requestId, client = 'web') {
  const adapted = adaptV2ToLegacyHttp({
    v2Response,
    requestId,
    client,
    runtimeConfig: { response: { exposeDebugMeta: false } },
    engineMeta: { primary: 'v3', mode: 'v3', percent: 100, bucket: 0 },
    latencyMs: Number(v2Response?.latency_ms || 0)
  });
  return parseHttpJsonBody(adapted);
}

async function postChat(request, reply) {
  const body = request.body || {};
  const reqLike = makeRequestLike(request, body);
  const normalizedReq = normalizeMessageRequest(body, reqLike);
  if (!normalizedReq.content) {
    reply.code(400).send({ error: 'content is required' });
    return;
  }

  const result = await handleConversation(normalizedReq, request.ctx);

  if (body.compat_legacy === true || String(request.query?.shape || '').toLowerCase() === 'legacy') {
    reply.send(toLegacyShape(result, normalizedReq.request_id, normalizedReq.channel));
    return;
  }

  reply.send(normalizeMessageResponse(result));
}

async function postChatStream(request, reply) {
  const body = request.body || {};
  const reqLike = makeRequestLike(request, body);
  const normalizedReq = normalizeMessageRequest(body, reqLike);
  if (!normalizedReq.content) {
    reply.code(400).send({ error: 'content is required' });
    return;
  }

  if (typeof reply.hijack === 'function') {
    reply.hijack();
  }
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('x-request-id', normalizedReq.request_id);

  const write = (data) => reply.raw.write(encodeSse(data));

  try {
    write({ type: 'thinking', stage: 'analyzing_request' });
    const result = await handleConversation(normalizedReq, request.ctx);
    const normalized = normalizeMessageResponse(result);

    for (const call of normalized.tool_calls || []) {
      write({ type: 'tool_call', tool: call.tool, status: call.status, duration_ms: call.duration_ms });
    }

    const text = String(normalized.content || '');
    const chunkSize = 8;
    for (let i = 0; i < text.length; i += chunkSize) {
      write({ type: 'token', content: text.slice(i, i + chunkSize) });
    }

    write({
      type: 'meta',
      id: normalized.id,
      safety: normalized.safety,
      persona: normalized.persona,
      memory_refs: normalized.memory_refs,
      usage: normalized.usage,
      latency_ms: normalized.latency_ms,
      meta: normalized.meta
    });
    write({ type: 'complete' });
    write('[DONE]');
  } catch (err) {
    write({ type: 'error', message: err.message || 'stream_error' });
    write('[DONE]');
  }

  reply.raw.end();
}

module.exports = {
  postChat,
  postChatStream
};
