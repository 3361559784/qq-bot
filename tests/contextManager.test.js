const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLLMMessages,
  buildResponseStyleLine,
  buildRecentStyleSummary
} = require('../src/v2/core/contextManager');

test('buildResponseStyleLine defaults to brief mode', () => {
  const line = buildResponseStyleLine();
  assert.match(line, /简要直答|1-3句/);
});

test('buildResponseStyleLine supports professional mode', () => {
  const line = buildResponseStyleLine({ mode: 'professional' });
  assert.match(line, /专业问题/);
  assert.match(line, /推导|示例/);
});

test('buildLLMMessages injects response policy guidance into system prompt', () => {
  const builtContext = {
    history: { short: [{ role: 'assistant', content: '上轮回复' }] },
    memory: []
  };

  const briefMessages = buildLLMMessages(
    { content: '今天天气怎么样？' },
    builtContext,
    [],
    null,
    '',
    { mode: 'brief' }
  );
  assert.match(briefMessages[0].content, /简要直答|1-3句/);

  const professionalMessages = buildLLMMessages(
    { content: '请写一个二分查找并分析复杂度。' },
    builtContext,
    [],
    null,
    '',
    { mode: 'professional' }
  );
  assert.match(professionalMessages[0].content, /专业问题/);
});

test('buildRecentStyleSummary summarizes last assistant style', () => {
  const summary = buildRecentStyleSummary([
    { role: 'assistant', content: '（轻声）老师先休息一下。' },
    { role: 'assistant', content: '我们先拆成两个步骤处理，好吗？' },
    { role: 'assistant', content: '如果你愿意，我可以继续展开。' }
  ]);

  assert.match(summary, /最近3轮风格摘要/);
  assert.match(summary, /动作前缀/);
});

test('buildLLMMessages injects scene skeleton hint when provided', () => {
  const builtContext = {
    history: { short: [{ role: 'assistant', content: '上一轮回复' }] },
    memory: []
  };

  const messages = buildLLMMessages(
    { content: '今天有点难过' },
    builtContext,
    [],
    null,
    '',
    { mode: 'brief' },
    {
      key: 'emotional_support',
      systemHint: '场景骨架：先接住情绪，再给一个可执行的小步骤。'
    }
  );

  assert.match(messages[0].content, /场景骨架/);
  assert.match(messages[0].content, /先接住情绪/);
});

test('buildLLMMessages injects roleplay overlay hint when active overlay exists', () => {
  const builtContext = {
    history: { short: [] },
    memory: [],
    active_overlay: {
      noPunctuation: true,
      oneLine: true,
      address: '队长',
      justTriggered: true,
      exactReply: '收到'
    }
  };

  const messages = buildLLMMessages(
    { content: '听懂就回复我（收到）不要加标点' },
    builtContext,
    [],
    null,
    '',
    { mode: 'brief' },
    null
  );

  assert.match(messages[0].content, /临时角色跟随/);
  assert.match(messages[0].content, /不加标点|单行短句|指定短句/);
});
