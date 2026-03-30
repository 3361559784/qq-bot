const test = require('node:test');
const assert = require('node:assert/strict');

const { planCapabilities } = require('../src/v2/core/capabilityPlanner');

test('capabilityPlanner: casual chat should stay in chat mode', () => {
  const plan = planCapabilities({ content: '今天好累，想随便聊聊' });
  assert.equal(plan.mode, 'chat');
  assert.equal(plan.capabilities.includes('none'), true);
});

test('capabilityPlanner: explicit weather query should trigger weather capability', () => {
  const plan = planCapabilities({ content: '武汉天气怎么样' });
  assert.equal(plan.mode, 'capability');
  assert.equal(plan.capabilities.includes('weather'), true);
});

test('capabilityPlanner: explicit draw query should trigger draw capability', () => {
  const plan = planCapabilities({ content: '帮我画一张星空校园' });
  assert.equal(plan.mode, 'capability');
  assert.equal(plan.capabilities.includes('draw'), true);
});
