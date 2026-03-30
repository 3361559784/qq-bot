const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectConversationScenario,
  structureReplyByScenario
} = require('../src/v2/core/styleGuards');
const { selectSceneSkeleton } = require('../src/v2/core/sceneSkeletonRegistry');

test('response structure: learning support scene keeps core answer intact', () => {
  const req = {
    user_id: 'u1',
    content: '请写一个二分查找并分析复杂度'
  };

  const sceneContext = detectConversationScenario(req, {
    capabilityMode: 'chat',
    responsePolicyMode: 'professional',
    safetyAction: 'pass'
  });

  const sceneSkeleton = selectSceneSkeleton(req, {
    responsePolicy: { mode: 'professional' },
    historyTurns: []
  });

  const out = structureReplyByScenario('时间复杂度是 O(log n)。', {
    sceneContext,
    sceneSkeleton,
    historyTurns: [],
    capabilityMode: 'chat',
    safetyAction: 'pass'
  });

  assert.match(out, /O\(log n\)/);
  assert.equal(out, '时间复杂度是 O(log n)。');
});

test('response structure: bedtime keeps soft tone and follow-up', () => {
  const req = {
    user_id: 'u2',
    content: '晚安，我先睡了'
  };

  const sceneContext = detectConversationScenario(req, {
    capabilityMode: 'chat',
    responsePolicyMode: 'brief',
    safetyAction: 'pass'
  });

  const out = structureReplyByScenario('今天辛苦了。', {
    sceneContext,
    historyTurns: [{ role: 'assistant', content: '上一轮' }],
    capabilityMode: 'chat',
    safetyAction: 'pass'
  });

  assert.match(out, /辛苦|休息|晚安|存档/);
});

test('response structure: capability mode bypasses restructuring', () => {
  const text = '已生成图片：https://example.com/a.png';
  const out = structureReplyByScenario(text, {
    sceneContext: {
      key: 'casual_chat',
      shouldStructure: false
    },
    capabilityMode: 'capability',
    safetyAction: 'pass'
  });

  assert.equal(out, text);
});
