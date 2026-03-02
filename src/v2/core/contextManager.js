const { getContext, searchMemory } = require('../services/memoryService');

async function buildConversationContext(req, context = null) {
  const [historyBundle, memoryHits] = await Promise.all([
    getContext(req.user_id, req.context_id, context),
    searchMemory(req.user_id, req.content, 4, context)
  ]);

  return {
    history: historyBundle,
    memory: memoryHits,
    memoryRefs: memoryHits.map((x) => x.id)
  };
}

function buildLLMMessages(req, builtContext, toolCalls) {
  const memoryLines = (builtContext.memory || []).map((m) => `- ${m.kind}: ${m.content}`).join('\n');
  const toolLines = (toolCalls || [])
    .filter((x) => x.status === 'success' && x.output)
    .map((x) => `- ${x.tool}: ${typeof x.output === 'string' ? x.output : (x.output.message || JSON.stringify(x.output))}`)
    .join('\n');

  const system = [
    '你是校园 AI 助手 Aris，输出要准确、简洁、可执行。',
    '禁止编造数据；不确定就明确说缺口。',
    '如果工具结果存在，以工具结果为主。',
    memoryLines ? `用户记忆:\n${memoryLines}` : '',
    toolLines ? `工具结果:\n${toolLines}` : ''
  ].filter(Boolean).join('\n\n');

  const history = builtContext.history.short || [];
  const messages = [{ role: 'system', content: system }];

  for (const item of history) {
    messages.push({ role: item.role, content: item.content });
  }

  messages.push({ role: 'user', content: req.content });
  return messages;
}

module.exports = {
  buildConversationContext,
  buildLLMMessages
};
