const test = require('node:test');
const assert = require('node:assert/strict');
const { selectSchoolBotEngine } = require('../../../src/functions/schoolbot/runtime/engineSelector');

test('engine selector: default legacy mode', () => {
  const out = selectSchoolBotEngine({
    requestId: 'rid_1',
    userId: 'u1',
    runtimeConfig: { engine: { mode: 'legacy', v2Percent: 100 } }
  });

  assert.equal(out.mode, 'legacy');
  assert.equal(out.primary, 'legacy');
  assert.equal(out.shadow, null);
});

test('engine selector: v2 mode with zero percent keeps legacy', () => {
  const out = selectSchoolBotEngine({
    requestId: 'rid_2',
    userId: 'u1',
    runtimeConfig: { engine: { mode: 'v2', v2Percent: 0 } }
  });

  assert.equal(out.mode, 'v2');
  assert.equal(out.primary, 'legacy');
  assert.equal(out.sampledToV2, false);
});

test('engine selector: shadow mode can enable v2 shadow run', () => {
  const out = selectSchoolBotEngine({
    requestId: 'rid_3',
    userId: 'u1',
    runtimeConfig: { engine: { mode: 'shadow', v2Percent: 100 } }
  });

  assert.equal(out.mode, 'shadow');
  assert.equal(out.primary, 'legacy');
  assert.equal(out.shadow, 'v2');
  assert.equal(out.sampledToV2, true);
});
