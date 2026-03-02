const test = require('node:test');
const assert = require('node:assert/strict');

test('public bridge exposes accessor API', () => {
  const bridge = require('../../src/functions/schoolBot');
  assert.equal(typeof bridge.handleScheduleRequest, 'function');
  assert.equal(typeof bridge.getCosmosContainer, 'function');
  assert.equal(typeof bridge.getGithubToken, 'function');
});

test('dependent function modules load with bridge API', () => {
  assert.doesNotThrow(() => {
    require('../../src/functions/ocrCourse');
    require('../../src/functions/scrapeChaoxing');
  });
});
