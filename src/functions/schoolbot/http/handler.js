const { app } = require('@azure/functions');
const { getRequestId } = require('./requestParser');
const { routeNonChatEvents } = require('./eventRouter');
const { getRuntimeConfig } = require('../config/runtime');
const { validateIngressAuth } = require('./authGuard');
const { adaptV2ToLegacyHttp, extractReplyFromHttpResponse } = require('./responseAdapter');
const { selectSchoolBotEngine } = require('../runtime/engineSelector');
const { runV2Engine } = require('../runtime/v2Engine');
const legacyEngine = require('../runtime/legacyEngine');

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function safeReadBodyText(request) {
  try {
    return await request.text();
  } catch {
    return '';
  }
}

function createReplayableRequest(request, bodyText) {
  const replay = Object.create(request || null);
  replay.text = async () => bodyText || '';
  replay.json = async () => {
    const parsed = safeJsonParse(bodyText);
    if (parsed !== null) return parsed;
    throw new Error('Invalid JSON body');
  };
  return replay;
}

function resolveClient(body) {
  if (body?.post_type === 'message' || body?.post_type === 'notice') return 'qq';
  if (body?.message || body?.content) return 'web';
  return 'unknown';
}

function resolveUserId(body) {
  if (!body || typeof body !== 'object') return 'unknown';
  return String(
    body.user_id
    || body.sender?.user_id
    || body.sender?.id
    || body.sessionId
    || body.conversationId
    || 'unknown'
  );
}

function makeUnauthorizedResponse(authResult, requestId) {
  return {
    status: Number(authResult?.status || 401),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      reply: authResult?.message || 'Unauthorized request.',
      persona: 'professional',
      meta: {
        requestId,
        auth: {
          ok: false,
          reason: authResult?.reason || 'unauthorized'
        }
      },
      auto_escape: false
    })
  };
}

async function maybeRunShadowV2({
  replayableRequest,
  body,
  context,
  requestId,
  client,
  runtimeConfig,
  engineMeta,
  primaryResponse
}) {
  try {
    const shadow = await runV2Engine({
      request: replayableRequest,
      body,
      context,
      requestId
    });

    if (!shadow.ok) {
      context.log(`[schoolbot/shadow] request=${requestId} skipped=${shadow.type}`);
      return;
    }

    const adaptedShadow = adaptV2ToLegacyHttp({
      v2Response: shadow.response,
      requestId,
      client,
      runtimeConfig,
      engineMeta: {
        ...engineMeta,
        primary: 'v2'
      },
      latencyMs: Number(shadow.response?.latency_ms || 0)
    });

    const legacyReply = extractReplyFromHttpResponse(primaryResponse);
    const v2Reply = extractReplyFromHttpResponse(adaptedShadow);
    const replyMatch = legacyReply === v2Reply;

    context.log(
      `[schoolbot/shadow] request=${requestId} reply_match=${replyMatch} legacy_len=${legacyReply.length} v2_len=${v2Reply.length}`
    );
  } catch (err) {
    context.log(`[schoolbot/shadow] request=${requestId} error=${err.message}`);
  }
}

async function schoolBotHttpHandler(request, context) {
  const startedAt = Date.now();
  const runtimeConfig = getRuntimeConfig(process.env);

  const bodyText = await safeReadBodyText(request);
  const body = safeJsonParse(bodyText);
  const replayableRequest = createReplayableRequest(request, bodyText);

  const requestId = getRequestId(replayableRequest, body || undefined);
  const client = resolveClient(body);
  const userId = resolveUserId(body);

  const authResult = validateIngressAuth({
    request: replayableRequest,
    bodyText,
    runtimeConfig
  });

  if (!authResult.ok) {
    context.log(`[schoolbot/auth] request=${requestId} denied reason=${authResult.reason}`);
    return makeUnauthorizedResponse(authResult, requestId);
  }

  if (body && typeof body === 'object') {
    const legacyEventConfig = legacyEngine.getLegacyEventConfig();
    const nonChatEventResp = await routeNonChatEvents({
      body,
      selfId: body.self_id,
      context,
      arisDisablePoke: legacyEventConfig.arisDisablePoke,
      botQqId: legacyEventConfig.botQqId,
      cosmosContainer: legacyEngine.getCosmosContainer(),
      handlePokeLogic: legacyEngine.handlePokeLogic,
      updateLastBotReply: legacyEngine.updateLastBotReply
    });

    if (nonChatEventResp) {
      return nonChatEventResp;
    }
  }

  const engineMeta = selectSchoolBotEngine({
    requestId,
    userId,
    runtimeConfig
  });

  context.log(
    `[schoolbot/engine] request=${requestId} mode=${engineMeta.mode} primary=${engineMeta.primary} shadow=${engineMeta.shadow || 'none'} percent=${engineMeta.percent} bucket=${engineMeta.bucket}`
  );

  if (engineMeta.primary === 'v2') {
    const v2Result = await runV2Engine({
      request: replayableRequest,
      body,
      context,
      requestId
    });

    if (!v2Result.ok && v2Result.type === 'no_message_content') {
      return {
        status: 200,
        jsonBody: { status: 'ok', message: 'no_message_content' }
      };
    }

    return adaptV2ToLegacyHttp({
      v2Response: v2Result.response,
      requestId,
      client,
      runtimeConfig,
      engineMeta,
      latencyMs: Date.now() - startedAt
    });
  }

  const legacyResponse = await legacyEngine.runLegacyHandler(replayableRequest, context);

  if (engineMeta.shadow === 'v2') {
    await maybeRunShadowV2({
      replayableRequest,
      body,
      context,
      requestId,
      client,
      runtimeConfig,
      engineMeta,
      primaryResponse: legacyResponse
    });
  }

  return legacyResponse;
}

app.http('schoolBot', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: schoolBotHttpHandler
});

module.exports = {
  handleScheduleRequest: legacyEngine.handleScheduleRequest,
  getCosmosContainer: legacyEngine.getCosmosContainer,
  getGithubToken: legacyEngine.getGithubToken,
  aiPostProcess: legacyEngine.aiPostProcess,
  detectLanguage: legacyEngine.detectLanguage,
  getPromptByLanguage: legacyEngine.getPromptByLanguage,
  simpleVectorize: legacyEngine.simpleVectorize,
  cosineSimilarity: legacyEngine.cosineSimilarity,
  schoolBotHttpHandler,
  selectSchoolBotEngine
};
