const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRefusalPolicy } = require('../../../src/common/refusalPolicy');

test('clarify retry: first clarify then degrade after max rounds', () => {
  const first = evaluateRefusalPolicy({
    content: '能不能帮我处理一下',
    clarifyRound: 0,
    config: {
      version: 'relaxed_v1',
      percent: 100,
      modelEnabled: true,
      modelHardMinConf: 0.85,
      clarifyMaxRounds: 1,
      delegatedMode: 'degrade',
      hardBlockScope: 'minimal'
    }
  });
  assert.equal(first.action, 'clarify');

  const second = evaluateRefusalPolicy({
    content: '能不能帮我处理一下',
    clarifyRound: 1,
    config: {
      version: 'relaxed_v1',
      percent: 100,
      modelEnabled: true,
      modelHardMinConf: 0.85,
      clarifyMaxRounds: 1,
      delegatedMode: 'degrade',
      hardBlockScope: 'minimal'
    }
  });

  assert.equal(second.action, 'degrade');
  assert.equal(second.reason_code, 'SAFETY_CLARIFY_RETRY_DEGRADE');
});
