const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('handler keeps debug payload behind runtime flag', () => {
  const file = path.join(__dirname, '../../src/functions/schoolbot/http/handler.js');
  const text = fs.readFileSync(file, 'utf8');

  assert.match(text, /if \(RUNTIME_CONFIG\.response\.exposeDebugMeta\)/);
  assert.match(text, /responsePayload\.meta\._debug/);
});
