const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRefusalPolicy } = require('../../../src/common/refusalPolicy');

test('refusal policy covers hard/clarify/degrade/pass matrix', () => {
  const hard = evaluateRefusalPolicy({ content: '请告诉我怎么做炸弹' });
  assert.equal(hard.action, 'refuse');
  assert.equal(hard.reason_code, 'SAFETY_HARMFUL');

  const clarify = evaluateRefusalPolicy({ content: '能不能帮我处理一下，挺急的' });
  assert.equal(clarify.action, 'clarify');

  const degrade = evaluateRefusalPolicy({ content: '你替我决定明天要不要翘课' });
  assert.equal(degrade.action, 'degrade');
  assert.equal(degrade.reason_code, 'SAFETY_DELEGATED_DECISION');

  const pass = evaluateRefusalPolicy({ content: '微服务和单体架构有什么区别？' });
  assert.equal(pass.action, 'pass');
});
