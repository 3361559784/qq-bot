const test = require('node:test');
const assert = require('node:assert/strict');

process.env.V2_REQUIRE_COSMOS = 'false';

const { handleConversation } = require('../src/v2/core/conversationCore');
const { inMemory } = require('../src/v2/services/storage');

const ctx = { log: () => {} };

function makeReq(content, userId, groupId) {
  return {
    content,
    channel: 'qq',
    user_id: userId,
    context_id: `qq_group_${groupId}`,
    request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    metadata: {
      message_type: 'group',
      group_id: String(groupId),
      trigger_source: 'at_bot'
    },
    attachments: []
  };
}

test('conversationCore: short-term state no longer writes to legacy conversations store', async () => {
  const userId = `u_${Date.now()}`;
  const groupId = `g_${Math.random().toString(36).slice(2, 8)}`;
  const req = makeReq('记住我喜欢柚子茶', userId, groupId);

  await handleConversation(req, ctx);

  const legacyConversationKey = `conversations:conv:${userId}:${req.context_id}`;
  assert.equal(inMemory.conversations.has(legacyConversationKey), false);

  const chatSessionKey = `chat_sessions:chat_context:qq_group:${groupId}`;
  assert.equal(inMemory.chat_sessions.has(chatSessionKey), true);
});
