const test = require('node:test');
const assert = require('node:assert/strict');

process.env.V2_REQUIRE_COSMOS = 'false';

const { handleConversation } = require('../src/v2/core/conversationCore');

function buildReq(content, overrides = {}) {
  return {
    content,
    channel: 'qq',
    user_id: overrides.user_id || `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    context_id: overrides.context_id || 'qq_group_10086',
    attachments: overrides.attachments || [],
    metadata: {
      trigger_source: overrides.trigger_source || 'at_bot',
      ...overrides.metadata
    },
    request_id: overrides.request_id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  };
}

const ctx = {
  log: () => {}
};

test('conversationCore: identity query uses role-consistent identity_meta mode', async () => {
  const req = buildReq('你是谁？');
  const resp = await handleConversation(req, ctx);

  assert.equal(resp.meta.reply_mode, 'identity_meta');
  assert.match(resp.content, /爱丽丝/);
  assert.equal(/智能助手/.test(resp.content), false);
});

test('conversationCore: memory query should not default to no-long-memory wording', async () => {
  const req = buildReq('你有没有长记忆');
  const resp = await handleConversation(req, ctx);

  assert.equal(resp.meta.reply_mode, 'identity_meta');
  assert.equal(/没有长记忆/.test(resp.content), false);
  assert.match(resp.content, /记住一部分重要信息|长期记忆|记住/);
});

test('conversationCore: exact-format roleplay overlay applies and expires after 2 following turns', async () => {
  const userId = `overlay_user_${Date.now()}`;
  const contextId = 'qq_group_overlay';

  const r1 = await handleConversation(buildReq('听懂就回复我（收到）不要加标点', { user_id: userId, context_id: contextId }), ctx);
  assert.equal(r1.meta.overlay_applied, true);
  assert.equal(r1.content, '收到');
  assert.equal(r1.meta.memory_write_ids.length, 0);

  const r2 = await handleConversation(buildReq('第二句', { user_id: userId, context_id: contextId }), ctx);
  assert.equal(r2.meta.overlay_applied, true);

  const r3 = await handleConversation(buildReq('第三句', { user_id: userId, context_id: contextId }), ctx);
  assert.equal(r3.meta.overlay_applied, true);

  const r4 = await handleConversation(buildReq('第四句', { user_id: userId, context_id: contextId }), ctx);
  assert.equal(r4.meta.overlay_applied, false);
});

test('conversationCore: normal QQ chat should not fall back to task-menu wording', async () => {
  const req = buildReq('在吗，想聊聊今天发生的事');
  const resp = await handleConversation(req, ctx);

  assert.equal(resp.meta.reply_mode, 'chat');
  assert.equal(/课表|天气|搜索|任务/.test(resp.content), false);
});

test('conversationCore: capability does not hijack casual chat but triggers on explicit draw', async () => {
  const casual = await handleConversation(buildReq('今天有点累，想聊聊'), ctx);
  assert.equal(casual.tool_calls.length, 0);
  assert.equal(casual.meta.reply_mode, 'chat');

  const draw = await handleConversation(buildReq('帮我画一张夜晚校园'), ctx);
  assert.equal(draw.meta.reply_mode, 'capability');
  assert.equal(draw.tool_calls.some((x) => x.tool === 'draw.generate_image'), true);
});

test('conversationCore: meta-topic mention should not be over-avoided by style guards', async () => {
  const req = buildReq('你的模型和 prompt 能简单说吗');
  const resp = await handleConversation(req, ctx);

  assert.equal(resp.meta.reply_mode, 'identity_meta');
  assert.equal(/更想陪老师聊当下/.test(resp.content), false);
  assert.equal(/系统提示词原文/.test(resp.content), false);
});

test('conversationCore: explicit remember request writes long-term memory ids', async () => {
  const req = buildReq('记住我喜欢抹茶拿铁');
  const resp = await handleConversation(req, ctx);

  assert.equal(Array.isArray(resp.meta.memory_write_ids), true);
  assert.equal(resp.meta.memory_write_ids.length > 0, true);
});
