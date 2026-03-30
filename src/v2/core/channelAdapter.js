const { generateId, trimContent } = require('../utils');
const { V2_DEFAULTS } = require('../constants');
const { normalizeMediaValue } = require('./qqMediaResolver');

function parseCqParams(raw = '') {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const i = pair.indexOf('=');
      if (i <= 0) return acc;
      const key = pair.slice(0, i).trim();
      const val = normalizeMediaValue(pair.slice(i + 1));
      if (key) acc[key] = val;
      return acc;
    }, {});
}

function parseCqSegments(message = '') {
  const text = String(message || '');
  const segs = [];
  const re = /\[CQ:([a-zA-Z0-9_-]+)(?:,([^\]]*))?\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    segs.push({ type: m[1], data: parseCqParams(m[2] || '') });
  }
  return segs;
}

function stripCqText(message = '') {
  return String(message || '')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAttachmentsFromSegments(segments = []) {
  const isHttp = (value = '') => /^https?:\/\//i.test(String(value || '').trim());
  const out = [];
  for (const seg of segments) {
    if (!seg || !seg.type) continue;
    if (seg.type === 'image') {
      const rawUrl = String(seg.data?.url || '').trim();
      const rawFile = String(seg.data?.file || '').trim();
      const directUrl = isHttp(rawUrl) ? rawUrl : (isHttp(rawFile) ? rawFile : '');
      const unresolved = !directUrl && !!(rawFile || rawUrl);

      out.push({
        type: 'image',
        url: directUrl,
        file: rawFile || rawUrl || '',
        unresolved,
        raw: seg
      });
    } else if (seg.type === 'file') {
      const rawUrl = String(seg.data?.url || '').trim();
      const rawFile = String(seg.data?.file || '').trim();
      out.push({
        type: 'file',
        url: isHttp(rawUrl) ? rawUrl : (isHttp(rawFile) ? rawFile : ''),
        file: rawFile || rawUrl || '',
        name: seg.data?.name || '',
        raw: seg
      });
    } else if (seg.type === 'video') {
      const rawUrl = String(seg.data?.url || '').trim();
      const rawFile = String(seg.data?.file || '').trim();
      out.push({
        type: 'video',
        url: isHttp(rawUrl) ? rawUrl : (isHttp(rawFile) ? rawFile : ''),
        file: rawFile || rawUrl || '',
        raw: seg
      });
    }
  }
  return out;
}

function normalizeLegacyQqEvent(body = {}, request = null) {
  const postType = String(body.post_type || '').trim().toLowerCase();
  const msgType = String(body.message_type || 'none').trim().toLowerCase();

  const isPoke = postType === 'notice' && (
    String(body.notice_type || '').toLowerCase() === 'poke' ||
    (String(body.notice_type || '').toLowerCase() === 'notify' && String(body.sub_type || '').toLowerCase() === 'poke')
  );

  let eventType = 'message';
  if (postType === 'message_sent') eventType = 'message_sent';
  else if (isPoke) eventType = 'poke';
  else if (postType !== 'message') eventType = postType || 'unknown';

  const rawContent = String(body.raw_message || body.message || '').trim();
  const segments = parseCqSegments(rawContent);
  const cleanContent = stripCqText(rawContent);

  const mentions = segments
    .filter((x) => x.type === 'at')
    .map((x) => String(x.data?.qq || '').trim())
    .filter(Boolean);

  const replySeg = segments.find((x) => x.type === 'reply');
  const replyTo = replySeg ? { id: replySeg.data?.id || null } : null;

  const requiresResponse = (
    eventType === 'poke' ||
    (eventType === 'message' && msgType === 'private')
  );

  return {
    event_type: eventType,
    message_type: ['private', 'group'].includes(msgType) ? msgType : 'none',
    user_id: String(body.user_id || body.sender?.user_id || '').trim(),
    group_id: body.group_id != null ? String(body.group_id) : null,
    self_id: body.self_id != null ? String(body.self_id) : null,
    content: cleanContent,
    raw_content: rawContent,
    mentions,
    reply_to: replyTo,
    attachments: parseAttachmentsFromSegments(segments),
    sender: body.sender || {},
    raw_payload: body,
    request_id: String(body.request_id || body.requestId || request?.headers?.get?.('x-request-id') || generateId('qqreq')),
    requires_response: requiresResponse
  };
}

function legacyQqToMessageRequest(event = {}) {
  const userId = String(event.user_id || 'qq_unknown');
  const groupId = event.group_id ? String(event.group_id) : null;
  const contextId = groupId ? `qq_group_${groupId}` : `qq_private_${userId}`;

  const metadata = {
    legacy: true,
    event_type: event.event_type,
    message_type: event.message_type,
    trigger_source: event.trigger_source || (event.message_type === 'group' ? 'group_trigger' : 'private_message'),
    group_id: groupId,
    self_id: event.self_id || null,
    mentions: Array.isArray(event.mentions) ? event.mentions : [],
    reply_to: event.reply_to || null,
    sender: event.sender || {},
    raw_payload: event.raw_payload || null,
    requires_response: !!event.requires_response
  };

  return {
    content: trimContent(String(event.content || event.raw_content || '').trim(), V2_DEFAULTS.limits.maxContentChars),
    channel: 'qq',
    user_id: userId,
    context_id: contextId,
    attachments: Array.isArray(event.attachments) ? event.attachments.slice(0, V2_DEFAULTS.limits.maxAttachments) : [],
    metadata,
    request_id: String(event.request_id || generateId('req'))
  };
}

function messageResponseToLegacyQqReply(response = {}, event = null) {
  let content = String(response?.content || '').trim();

  if (!content && Array.isArray(response?.tool_calls)) {
    const hit = response.tool_calls.find((x) => x?.status === 'success' && x?.output);
    const out = hit?.output;
    if (typeof out === 'string') content = out;
    else if (out && typeof out.message === 'string') content = out.message;
  }

  return {
    reply: content,
    auto_escape: false,
    persona: response?.persona || 'alice',
    meta: {
      request_id: response?.meta?.request_id || event?.request_id || null,
      latency_ms: Number(response?.latency_ms || 0),
      safety: response?.safety || null
    }
  };
}

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
    trigger_source: body.trigger_source || body.metadata?.trigger_source || (fromLegacyQq ? 'legacy_qq' : 'api'),
    memory_policy: body.memory_policy || body.metadata?.memory_policy || undefined,
    roleplay_overlay: body.roleplay_overlay || body.metadata?.roleplay_overlay || undefined,
    schedule: Array.isArray(body.schedule) ? body.schedule : undefined,
    image_url: normalizeMediaValue(body.image_url || body.imageUrl || '') || undefined,
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
    persona: response.persona || 'alice',
    tool_calls: Array.isArray(response.tool_calls) ? response.tool_calls : [],
    safety: response.safety,
    memory_refs: Array.isArray(response.memory_refs) ? response.memory_refs : [],
    usage: response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    latency_ms: Number(response.latency_ms || 0),
    meta: response.meta || {}
  };
}

module.exports = {
  normalizeLegacyQqEvent,
  legacyQqToMessageRequest,
  messageResponseToLegacyQqReply,
  normalizeMessageRequest,
  normalizeMessageResponse
};
