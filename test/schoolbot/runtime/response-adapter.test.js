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

test('response adapter: computer-use maps trust and job metadata', () => {
  const resp = adaptV2ToLegacyHttp({
    v2Response: {
      content: '已执行 3 步，等待确认',
      persona: 'professional',
      safety: { action: 'pass', reason_code: '' },
      tool_calls: [{
        tool: 'computer.use',
        status: 'success',
        output: {
          job_id: 'cujob_123',
          status: 'waiting_confirmation',
          steps_executed: 3,
          transport: 'mcp_stdio',
          provider: 'openai_byok',
          provider_mode: 'github_models',
          planner_model_selected: 'openai/gpt-5-nano',
          planner_model_attempts: 1
        }
      }],
      meta: { request_id: 'rid_cu' },
      latency_ms: 50
    },
    requestId: 'rid_cu',
    client: 'web',
    runtimeConfig: { response: { exposeDebugMeta: false } },
    engineMeta: { primary: 'v2', mode: 'v2', percent: 100, bucket: 20 },
    latencyMs: 50
  });

  const payload = parseHttpJsonBody(resp);
  assert.equal(payload.meta.sourceLabel, 'Local MCP Computer Use');
  assert.equal(payload.meta.trustLevel, 'local_automation_mcp');
  assert.equal(payload.meta.computer_use_job_id, 'cujob_123');
  assert.equal(payload.meta.computer_use_status, 'waiting_confirmation');
  assert.equal(payload.meta.computer_use_transport, 'mcp_stdio');
  assert.equal(payload.meta.computer_use_provider, 'openai_byok');
  assert.equal(payload.meta.computer_use_model, 'openai/gpt-5-nano');
  assert.equal(payload.meta.computer_use_provider_mode, 'github_models');
});
