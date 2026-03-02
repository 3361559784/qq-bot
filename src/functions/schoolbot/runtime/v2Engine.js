const { normalizeMessageRequest } = require('../../../v2/core/channelAdapter');
const { handleConversation } = require('../../../v2/core/conversationCore');

function enrichBodyForV2(body, request, requestId) {
  const next = body && typeof body === 'object' ? { ...body } : {};

  const queryMsg = request?.query?.get?.('msg');
  if (!next.message && !next.content && queryMsg) {
    next.message = String(queryMsg);
  }

  if (!next.request_id && !next.requestId) {
    next.request_id = requestId;
  }

  return next;
}

async function runV2Engine({ request, body, context, requestId }) {
  const payload = enrichBodyForV2(body, request, requestId);
  const messageReq = normalizeMessageRequest(payload, request);

  if (!messageReq.content) {
    return {
      ok: false,
      type: 'no_message_content',
      request: messageReq,
      response: null
    };
  }

  const response = await handleConversation(messageReq, context);

  return {
    ok: true,
    type: 'conversation',
    request: messageReq,
    response
  };
}

module.exports = {
  runV2Engine
};
