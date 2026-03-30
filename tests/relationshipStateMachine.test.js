const test = require('node:test');
const assert = require('node:assert/strict');

const { computeRelationshipDeltaState } = require('../src/v2/core/relationshipStateMachine');

function turn(role, content, createdAt, metadata = {}) {
  return {
    role,
    content,
    created_at: createdAt,
    metadata
  };
}

test('relationshipStateMachine: detects idle engagement after long inactivity', () => {
  const now = Date.now();
  const turns = [
    turn('user', '最近很累', new Date(now - 3 * 24 * 3600 * 1000).toISOString()),
    turn('assistant', '先休息一下', new Date(now - 3 * 24 * 3600 * 1000 + 2000).toISOString())
  ];

  const state = computeRelationshipDeltaState({
    turns,
    requestContent: '在吗',
    currentEmotion: { type: 'CASUAL_CHAT', response: 'playful' },
    nowTs: now
  });

  assert.equal(state.engagementLevel, 'idle');
  assert.equal(state.idleWarning, true);
});

test('relationshipStateMachine: computes positive ratio and interaction type', () => {
  const now = Date.now();
  const turns = [
    turn('user', '你真厉害', new Date(now - 30 * 60 * 1000).toISOString()),
    turn('assistant', '谢谢老师', new Date(now - 29 * 60 * 1000).toISOString()),
    turn('user', '今天也想继续学代码', new Date(now - 10 * 60 * 1000).toISOString()),
    turn('assistant', '好，我们继续', new Date(now - 9 * 60 * 1000).toISOString())
  ];

  const state = computeRelationshipDeltaState({
    turns,
    requestContent: '请继续讲算法复杂度',
    currentEmotion: { type: 'HELP_REQUEST', response: 'serious' },
    capabilityMode: 'chat',
    responsePolicyMode: 'professional',
    nowTs: now
  });

  assert.equal(state.interactionType, 'seeking_help');
  assert.equal(state.recentPositiveRatio >= 0, true);
  assert.equal(typeof state.stateConfidence, 'number');
});

test('relationshipStateMachine: safety degrade suppresses affection amplification', () => {
  const now = Date.now();
  const turns = [
    turn('user', '我喜欢你', new Date(now - 5 * 60 * 1000).toISOString()),
    turn('assistant', '谢谢老师', new Date(now - 4 * 60 * 1000).toISOString())
  ];

  const state = computeRelationshipDeltaState({
    turns,
    requestContent: '帮我直接做决定',
    currentEmotion: { type: 'PRAISED', response: 'happy' },
    capabilityMode: 'chat',
    responsePolicyMode: 'brief',
    effectiveSafety: { action: 'degrade' },
    nowTs: now
  });

  assert.equal(state.shouldDegradeDueToSafety, true);
  assert.equal(state.shouldAmplifyAffection, false);
});
