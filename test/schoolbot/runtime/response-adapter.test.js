const test = require('node:test');
const assert = require('node:assert/strict');
const { adaptV2ToLegacyHttp, parseHttpJsonBody } = require('../../../src/functions/schoolbot/http/responseAdapter');

test('response adapter: keeps required response contract keys', () => {
  const resp = adaptV2ToLegacyHttp({
    v2Response: {
      content: 'hello',
      persona: 'professional',
      safety: { action: 'pass', reason_code: '' },
      tool_calls: [{ tool: 'search.hybrid_search', status: 'success' }],
      meta: { request_id: 'rid_123' },
      latency_ms: 12
    },
    requestId: 'rid_123',
    client: 'web',
    runtimeConfig: { response: { exposeDebugMeta: false } },
    engineMeta: { primary: 'v2', mode: 'v2', percent: 100, bucket: 10 },
    latencyMs: 20
  });

  const payload = parseHttpJsonBody(resp);
  assert.equal(typeof payload.reply, 'string');
  assert.equal(typeof payload.persona, 'string');
  assert.equal(typeof payload.meta, 'object');
  assert.equal(typeof payload.auto_escape, 'boolean');
  assert.equal(payload.meta._debug, undefined);
});

test('response adapter: debug payload only when enabled', () => {
  const resp = adaptV2ToLegacyHttp({
    v2Response: {
      content: 'ok',
      persona: 'professional',
      safety: { action: 'pass', reason_code: '' },
      tool_calls: [{ tool: 'weather.get_weather', status: 'success' }],
      meta: { request_id: 'rid_debug', stage: 'completed' },
      latency_ms: 9
    },
    requestId: 'rid_debug',
    client: 'web',
    runtimeConfig: { response: { exposeDebugMeta: true } },
    engineMeta: { primary: 'v2', mode: 'v2', percent: 30, bucket: 1, sampledToV2: true },
    latencyMs: 11
  });

  const payload = parseHttpJsonBody(resp);
  assert.equal(typeof payload.meta._debug, 'object');
  assert.equal(payload.meta._debug.engineMode, 'v2');
});
