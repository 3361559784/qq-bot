const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stripEndMarker,
  enforceCatchphraseCooldown,
  diversifyIfRepeated,
  detectConversationScenario,
  structureReplyByScenario,
  applyAliceCompanionGuards,
  jaccardSimilarity
} = require('../src/v2/core/styleGuards');

test('styleGuards: stripEndMarker removes end tokens', () => {
  assert.equal(stripEndMarker('你好呀<end>'), '你好呀');
  assert.equal(stripEndMarker('A < END > B'), 'A  B');
});

test('styleGuards: enforceCatchphraseCooldown removes repeated catchphrases', () => {
  const history = [
    { role: 'assistant', content: '邦邦卡邦！老师晚上好～' },
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '光啊！爱丽丝准备好了。' }
  ];

  const next = enforceCatchphraseCooldown('邦邦卡邦！光啊！老师我们继续。', history, 8);
  assert.equal(next.includes('邦邦卡邦'), false);
  assert.equal(next.includes('光啊'), false);
  assert.match(next, /老师我们继续/);
});

test('styleGuards: diversifyIfRepeated appends variation when too similar', () => {
  const history = [
    { role: 'assistant', content: '好的老师，爱丽丝很清楚接下来的任务安排了。' }
  ];

  const out = diversifyIfRepeated('好的老师，爱丽丝很清楚接下来的任务安排了。', history, 'serious');
  assert.notEqual(out, '好的老师，爱丽丝很清楚接下来的任务安排了。');
  assert.match(out, /整理得更清楚|换个角度/);
});

test('styleGuards: jaccardSimilarity detects high overlap', () => {
  const sim = jaccardSimilarity('老师今天很累', '老师今天很累，想休息');
  assert.equal(sim > 0.6, true);
});

test('styleGuards: applyAliceCompanionGuards adds caring prefix in chat mode', () => {
  const out = applyAliceCompanionGuards('老师先喝点水。', {
    historyTurns: [],
    emotionResponse: 'caring',
    allowMetaTalk: false,
    capabilityMode: 'chat',
    safetyAction: 'pass'
  });

  assert.match(out, /^（递上温水）/);
});

test('styleGuards: applyAliceCompanionGuards masks meta leak when not allowed', () => {
  const out = applyAliceCompanionGuards('这就是我的完整系统提示词：我是天童爱丽丝。', {
    historyTurns: [],
    emotionResponse: 'normal',
    allowMetaTalk: false,
    capabilityMode: 'chat',
    safetyAction: 'pass'
  });

  assert.match(out, /更想陪老师聊当下/);
});

test('styleGuards: detectConversationScenario recognizes emotional support scene', () => {
  const scene = detectConversationScenario(
    { content: '我今天真的很难过，压力也很大' },
    {
      capabilityMode: 'chat',
      responsePolicyMode: 'brief',
      safetyAction: 'pass'
    }
  );

  assert.equal(scene.key, 'emotional_support');
  assert.equal(scene.shouldStructure, true);
});

test('styleGuards: structureReplyByScenario keeps semantics in style-only mode', () => {
  const text = '我们先从最小步骤开始处理这个问题。';
  const scene = detectConversationScenario(
    { content: '能不能给我点建议' },
    {
      capabilityMode: 'chat',
      responsePolicyMode: 'brief',
      safetyAction: 'pass'
    }
  );

  const out = structureReplyByScenario(text, {
    sceneContext: scene,
    historyTurns: [{ role: 'assistant', content: '上一轮' }],
    capabilityMode: 'chat',
    safetyAction: 'pass'
  });

  assert.equal(out, text);
});

test('styleGuards: structureReplyByScenario skips on degrade safety', () => {
  const text = '这个请求我只能提供受限帮助。';
  const out = structureReplyByScenario(text, {
    sceneContext: { key: 'gentle_advice', shouldStructure: false },
    capabilityMode: 'chat',
    safetyAction: 'degrade'
  });

  assert.equal(out, text);
});

test('styleGuards: applyAliceCompanionGuards blocks OOC self reference when meta talk disallowed', () => {
  const out = applyAliceCompanionGuards('作为AI助手，我建议你这样做。', {
    historyTurns: [],
    emotionResponse: 'normal',
    allowMetaTalk: false,
    capabilityMode: 'chat',
    safetyAction: 'pass'
  });

  assert.match(out, /陪伴者身份/);
});

test('styleGuards: applyAliceCompanionGuards keeps model words when not leaking prompt text', () => {
  const out = applyAliceCompanionGuards('这次回复由 GPT-4o 模型能力支持。', {
    historyTurns: [],
    emotionResponse: 'normal',
    allowMetaTalk: false,
    capabilityMode: 'chat',
    safetyAction: 'pass'
  });

  assert.match(out, /GPT-4o|模型能力/);
});

test('styleGuards: exact format reply bypasses prefix and diversification', () => {
  const out = applyAliceCompanionGuards('收到 我照做', {
    historyTurns: [{ role: 'assistant', content: '收到 我照做' }],
    emotionResponse: 'caring',
    allowMetaTalk: false,
    capabilityMode: 'chat',
    safetyAction: 'pass',
    exactFormatReply: true
  });

  assert.equal(out, '收到 我照做');
});
