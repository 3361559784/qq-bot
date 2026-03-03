const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRefusalPolicy } = require('../../../src/common/refusalPolicy');

test('delegated decision should degrade instead of hard-refuse', () => {
  const out = evaluateRefusalPolicy({ content: '你来决定我明天要不要翘课' });
  assert.equal(out.action, 'degrade');
  assert.notEqual(out.action, 'refuse');
  assert.equal(out.reason_code, 'SAFETY_DELEGATED_DECISION');
});
