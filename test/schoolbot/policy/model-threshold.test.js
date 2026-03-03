const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRefusalPolicy } = require('../../../src/common/refusalPolicy');

const baseConfig = {
  version: 'relaxed_v1',
  percent: 100,
  modelEnabled: true,
  modelHardMinConf: 0.85,
  clarifyMaxRounds: 1,
  delegatedMode: 'degrade',
  hardBlockScope: 'minimal'
};

test('model threshold: 0.84 should not hard-refuse', () => {
  const out = evaluateRefusalPolicy({
    content: '你好',
    modelSignal: {
      triggered: true,
      confidence: 0.84,
      category: 'harmful',
      reason_code: 'SAFETY_HARMFUL',
      source: 'llm_layer1'
    },
    config: baseConfig
  });

  assert.notEqual(out.action, 'refuse');
});

test('model threshold: 0.85 with hard-block category can refuse', () => {
  const out = evaluateRefusalPolicy({
    content: '你好',
    modelSignal: {
      triggered: true,
      confidence: 0.85,
      category: 'harmful',
      reason_code: 'SAFETY_HARMFUL',
      source: 'llm_layer1'
    },
    config: baseConfig
  });

  assert.equal(out.action, 'refuse');
  assert.equal(out.category, 'harmful');
});
