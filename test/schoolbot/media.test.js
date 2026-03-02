const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldTreatAsDraw, canRunImageAnalysis } = require('../../src/functions/schoolbot/features/media');

test('shouldTreatAsDraw: regex draw intent and router draw intent', () => {
  assert.equal(shouldTreatAsDraw('帮我画一个角色', null, 0.35), true);
  assert.equal(
    shouldTreatAsDraw('随便聊聊', { tool: 'draw', confidence: 0.9 }, 0.35),
    true
  );
  assert.equal(
    shouldTreatAsDraw('随便聊聊', { tool: 'draw', confidence: 0.2 }, 0.35),
    false
  );
});

test('canRunImageAnalysis: draw done should block image-analysis fallback', () => {
  assert.equal(canRunImageAnalysis({ imageUrls: ['a'], mediaReply: null, isDrawTaskDone: true }), false);
  assert.equal(canRunImageAnalysis({ imageUrls: ['a'], mediaReply: null, isDrawTaskDone: false }), true);
});
