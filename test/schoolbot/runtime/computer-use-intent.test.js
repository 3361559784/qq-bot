const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectComputerUseTrigger,
  buildComputerUseSkillInput
} = require('../../../src/v2/services/computerUseIntent');

test('computer-use intent: explicit prefix trigger', () => {
  const out = detectComputerUseTrigger('@cu 打开系统设置并点击蓝牙', { triggerMode: 'both' });
  assert.equal(out.triggered, true);
  assert.equal(out.trigger, 'explicit');
  assert.equal(out.objective, '打开系统设置并点击蓝牙');
});

test('computer-use intent: auto trigger', () => {
  const out = detectComputerUseTrigger('请你在浏览器里点击登录按钮并输入账号', { triggerMode: 'both' });
  assert.equal(out.triggered, true);
  assert.equal(out.trigger, 'auto');
});

test('computer-use intent: build skill input with trigger mode guard', () => {
  const blocked = buildComputerUseSkillInput('请你点击按钮', {}, { triggerMode: 'explicit' });
  assert.equal(blocked.triggered, false);

  const pass = buildComputerUseSkillInput('/cu 打开 Safari', {}, { triggerMode: 'explicit' });
  assert.equal(pass.triggered, true);
  assert.equal(pass.input.trigger, 'explicit');
  assert.equal(pass.input.objective, '打开 Safari');
});

