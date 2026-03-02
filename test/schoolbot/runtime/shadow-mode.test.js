const test = require('node:test');
const assert = require('node:assert/strict');
const { schoolBotHttpHandler } = require('../../../src/functions/schoolbot/http/handler');

function makeRequest(bodyObj) {
  const bodyText = JSON.stringify(bodyObj);
  return {
    method: 'POST',
    headers: {
      get: () => null
    },
    query: {
      get: () => null
    },
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText)
  };
}

function makeContext() {
  return {
    log: () => {},
    error: () => {},
    warn: () => {}
  };
}

test('shadow mode: primary response remains legacy-compatible', async () => {
  const prevMode = process.env.ARIS_SCHOOLBOT_ENGINE;
  const prevPercent = process.env.ARIS_SCHOOLBOT_V2_PERCENT;

  process.env.ARIS_SCHOOLBOT_ENGINE = 'shadow';
  process.env.ARIS_SCHOOLBOT_V2_PERCENT = '100';

  const req = makeRequest({ message: '' });
  const ctx = makeContext();

  const resp = await schoolBotHttpHandler(req, ctx);

  assert.equal(resp.status, 200);
  assert.equal(resp.jsonBody?.message, 'non_message_event');

  if (prevMode === undefined) delete process.env.ARIS_SCHOOLBOT_ENGINE;
  else process.env.ARIS_SCHOOLBOT_ENGINE = prevMode;

  if (prevPercent === undefined) delete process.env.ARIS_SCHOOLBOT_V2_PERCENT;
  else process.env.ARIS_SCHOOLBOT_V2_PERCENT = prevPercent;
});
