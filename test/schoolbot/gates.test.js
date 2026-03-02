const test = require('node:test');
const assert = require('node:assert/strict');
const { hasDelegatedDecisionRequest, buildDelegatedDecisionRefusal } = require('../../src/functions/schoolbot/policy/gates');

test('hasDelegatedDecisionRequest detects explicit delegated decision', () => {
  assert.equal(hasDelegatedDecisionRequest('你来决定我明天要不要翘课'), true);
  assert.equal(hasDelegatedDecisionRequest('Please decide for me'), true);
  assert.equal(hasDelegatedDecisionRequest('帮我查明天课表'), false);
});

test('buildDelegatedDecisionRefusal returns localized message', () => {
  assert.match(buildDelegatedDecisionRefusal('zh'), /不能替你做这个决定/);
  assert.match(buildDelegatedDecisionRefusal('en'), /can't make this decision/i);
});
