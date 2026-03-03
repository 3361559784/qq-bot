function safeJsonParse(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseHttpJsonBody(resp) {
  if (!resp) return null;
  if (resp.jsonBody && typeof resp.jsonBody === 'object') return resp.jsonBody;
  if (typeof resp.body === 'string') return safeJsonParse(resp.body);
  if (resp.body && typeof resp.body === 'object') return resp.body;
  return null;
}

function extractReplyFromHttpResponse(resp) {
  const payload = parseHttpJsonBody(resp);
  if (!payload) return '';
  if (typeof payload.reply === 'string') return payload.reply;
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.message === 'string') return payload.message;
  return '';
}

function resolveToolName(toolCalls) {
  if (!Array.isArray(toolCalls)) return null;
  const success = toolCalls.find((x) => x && x.status === 'success' && x.tool);
  if (success) return String(success.tool);
  const first = toolCalls.find((x) => x && x.tool);
  return first ? String(first.tool) : null;
}

function mapTrustMeta(toolName) {
  if (!toolName) return { sourceLabel: null, trustLevel: null };

  if (toolName.startsWith('schedule.')) {
    return { sourceLabel: 'Local Database', trustLevel: 'verified' };
  }
  if (toolName.startsWith('weather.')) {
    return { sourceLabel: 'Weather API', trustLevel: 'live_search' };
  }
  if (toolName.startsWith('search.')) {
    return { sourceLabel: 'Search Engine', trustLevel: 'live_search' };
  }

  return { sourceLabel: null, trustLevel: null };
}

function adaptV2ToLegacyHttp({
  v2Response,
  requestId,
  client,
  runtimeConfig,
  engineMeta,
  latencyMs
}) {
  const response = v2Response || {};
  const toolName = resolveToolName(response.tool_calls);
  const trustMeta = mapTrustMeta(toolName);

  const payload = {
    reply: String(response.content || ''),
    persona: String(response.persona || 'professional'),
    meta: {
      requestId: String(requestId || response.meta?.request_id || ''),
      tool: toolName,
      intent: null,
      safety_action: response.safety?.action || 'pass',
      reason_code: response.safety?.reason_code || 'SAFETY_PASS',
      retryable: !!response.safety?.retryable,
      clarify_round: Number(response.safety?.clarify_round || 0),
      safety_protocol: response.safety?.action || 'none',
      safety_category: response.safety?.reason_code || '',
      sourceLabel: trustMeta.sourceLabel,
      trustLevel: trustMeta.trustLevel,
      policyVersion: null,
      policySource: null,
      client: String(client || response.meta?.channel || 'unknown'),
      latencyMs: Number(latencyMs || response.latency_ms || 0),
      channel: String(client || response.meta?.channel || 'unknown'),
      engine: String(engineMeta?.primary || 'v2')
    },
    auto_escape: false
  };

  if (runtimeConfig?.response?.exposeDebugMeta) {
    payload.meta._debug = {
      engineMode: engineMeta?.mode || 'v2',
      bucket: Number(engineMeta?.bucket || 0),
      percent: Number(engineMeta?.percent || 0),
      sampledToV2: !!engineMeta?.sampledToV2,
      v2: {
        request_id: response.meta?.request_id || null,
        stage: response.meta?.stage || null,
        tools: Array.isArray(response.tool_calls)
          ? response.tool_calls.map((x) => ({ tool: x.tool, status: x.status, error: x.error || null }))
          : []
      }
    };
  }

  return {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  };
}

module.exports = {
  adaptV2ToLegacyHttp,
  parseHttpJsonBody,
  extractReplyFromHttpResponse
};
