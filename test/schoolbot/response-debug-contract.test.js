const test = require('node:test');
const assert = require('node:assert/strict');
const { adaptV2ToLegacyHttp, parseHttpJsonBody } = require('../../src/functions/schoolbot/http/responseAdapter');

test('debug payload is hidden by default and shown only with runtime flag', () => {
  const base = {
    v2Response: {
      content: 'hello',
      persona: 'professional',
      safety: { action: 'pass', reason_code: '' },
      tool_calls: [],
      meta: { request_id: 'rid' },
      latency_ms: 1
    },
    requestId: 'rid',
    client: 'web',
    engineMeta: { mode: 'v2', primary: 'v2', percent: 100, bucket: 0 },
    latencyMs: 1
  };

  const hidden = parseHttpJsonBody(adaptV2ToLegacyHttp({
    ...base,
    runtimeConfig: { response: { exposeDebugMeta: false } }
  }));
  assert.equal(hidden.meta._debug, undefined);

  const shown = parseHttpJsonBody(adaptV2ToLegacyHttp({
    ...base,
    runtimeConfig: { response: { exposeDebugMeta: true } }
  }));
  assert.equal(typeof shown.meta._debug, 'object');
});
