// @ts-nocheck
const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { handleConversation } = require('../v2/core/conversationCore');
const {
  normalizeLegacyQqEvent,
  legacyQqToMessageRequest,
  messageResponseToLegacyQqReply,
  normalizeMessageRequest
} = require('../v2/core/channelAdapter');
const { createScheduleHandler } = require('../../services/scheduleService');
const { checkComputerVision } = require('../../services/visionService');

const GROUP_TRIGGER_KEYWORDS = String(process.env.ARIS_GROUP_TRIGGER_KEYWORDS || 'aris,爱丽丝,alice')
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const COSMOS_DB = process.env.COSMOS_DB_DATABASE || 'QQBotDB';
const COSMOS_CONTAINER = process.env.COSMOS_DB_CONTAINER || 'QQBotData';

let cosmosContainer = null;
try {
  const conn = process.env.COSMOS_DB_STRING;
  if (conn) {
    const cosmosClient = new CosmosClient(conn);
    cosmosContainer = cosmosClient.database(COSMOS_DB).container(COSMOS_CONTAINER);
  }
} catch {
  cosmosContainer = null;
}

function getGithubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_MODELS_TOKEN || '';
}

async function fetchBypass(url, options = {}, retries = 1) {
  const timeoutMs = Number(options.timeoutMs || 12000);
  const method = options.method || 'GET';
  const headers = options.headers || {};
  const body = options.body;

  let lastErr = null;
  for (let i = 0; i <= retries; i += 1) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body,
        signal: ctrl.signal
      });
      clearTimeout(t);
      return resp;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('fetch_failed');
}

async function updateLastBotReply(container, dbKey, sessionKey) {
  if (!container || !dbKey || !sessionKey) return;
  try {
    const now = Date.now();
    const { resource } = await container.item(dbKey, dbKey).read();
    const doc = resource || { id: dbKey, history: [] };
    doc.lastBotReply = doc.lastBotReply || {};
    doc.lastBotReply[sessionKey] = now;
    doc.last_updated = new Date().toISOString();
    await container.items.upsert(doc);
  } catch {
    // adapter 层容错：不因状态写入失败影响主回复
  }
}

const handleScheduleRequest = createScheduleHandler({
  fetchBypass,
  checkComputerVision,
  updateLastBotReply
});

function parseLegacyQqEvent(body, request) {
  return normalizeLegacyQqEvent(body, request);
}

function shouldRespondToGroupEvent(event) {
  if (!event || event.event_type !== 'message' || event.message_type !== 'group') {
    return { respond: false, reason: 'not_group_message' };
  }

  const selfId = String(event.self_id || process.env.QQ_SELF_ID || '').trim();
  const raw = String(event.raw_content || '');
  const mentions = Array.isArray(event.mentions) ? event.mentions.map(String) : [];
  const hasAtBot = !!selfId && (
    mentions.includes(selfId) ||
    raw.includes(`[CQ:at,qq=${selfId}]`) ||
    raw.includes(`[CQ:at,qq=${selfId},`)
  );

  const textLower = String(event.content || '').toLowerCase();
  const hasKeyword = GROUP_TRIGGER_KEYWORDS.some((k) => textLower.includes(k));

  const attachments = Array.isArray(event.attachments) ? event.attachments : [];
  const hasImage = attachments.some((x) => String(x?.type || '').toLowerCase() === 'image');
  const pureImage = !String(event.content || '').trim() && hasImage;

  // reply + image + @bot 必须可触发
  if (hasAtBot) return { respond: true, reason: 'at_bot' };
  if (hasKeyword) return { respond: true, reason: 'keyword' };
  if (pureImage) return { respond: false, reason: 'pure_image_not_triggered' };

  return { respond: false, reason: 'group_not_triggered' };
}

function formatLegacyQqReply(response, event) {
  return messageResponseToLegacyQqReply(response, event);
}

async function handlePokeEvent(event, context) {
  const req = legacyQqToMessageRequest({
    ...event,
    event_type: 'poke',
    content: '你被戳了一下，友好回应但保持简短。',
    requires_response: true
  });
  const resp = await handleConversation(req, context);
  return formatLegacyQqReply(resp, event);
}

function json(body, status = 200) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
}

app.http('schoolBot', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'GET') {
      return json({ ok: true, route: '/api/schoolBot', mode: 'adapter', channel: 'qq' });
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      try {
        const raw = await request.text();
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
    }

    // Legacy QQ / NapCat 事件
    if (body?.post_type || body?.notice_type) {
      const event = parseLegacyQqEvent(body, request);

      // message_sent: 忽略，防止自循环
      if (event.event_type === 'message_sent') {
        return json({ reply: '', auto_escape: false, ignored: true, reason: 'message_sent' });
      }

      // notice/poke: 专门处理
      if (event.event_type === 'poke') {
        const payload = await handlePokeEvent(event, context);
        return json(payload);
      }

      // message/private: 硬静默，不进入主链
      if (event.event_type === 'message' && event.message_type === 'private') {
        return json({ ok: true, ignored: 'private_disabled', channel: 'qq' });
      }

      // message/group: 按触发规则进入核心
      if (event.event_type === 'message' && event.message_type === 'group') {
        const decision = shouldRespondToGroupEvent(event);
        if (!decision.respond) {
          return json({ reply: '', auto_escape: false, ignored: true, reason: decision.reason });
        }

        event.trigger_source = decision.reason;
        const req = legacyQqToMessageRequest(event);
        const resp = await handleConversation(req, context);
        return json(formatLegacyQqReply(resp, event));
      }

      return json({ reply: '', auto_escape: false, ignored: true, reason: 'unsupported_event' });
    }

    // API 调试入口：继续支持 message/content 直接请求
    const req = normalizeMessageRequest(body, request);
    if (!req.content) {
      return json({ error: 'content is required' }, 400);
    }

    const resp = await handleConversation(req, context);
    return json({
      reply: resp.content,
      persona: resp.persona,
      tool_calls: resp.tool_calls,
      safety: resp.safety,
      memory_refs: resp.memory_refs,
      usage: resp.usage,
      latency_ms: resp.latency_ms,
      meta: resp.meta
    });
  }
});

module.exports = {
  parseLegacyQqEvent,
  shouldRespondToGroupEvent,
  formatLegacyQqReply,
  handleScheduleRequest,
  cosmosContainer,
  get token() {
    return getGithubToken();
  }
};
