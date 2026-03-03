const test = require('node:test');
const assert = require('node:assert/strict');
const { adaptV2ToLegacyHttp, parseHttpJsonBody } = require('../../../src/functions/schoolbot/http/responseAdapter');

test('response adapter: maps planner model and provider mode to legacy meta', () => {
  const resp = adaptV2ToLegacyHttp({
    v2Response: {
      content: 'computer use done',
      persona: 'professional',
      safety: { action: 'pass', reason_code: '' },
      tool_calls: [{
        tool: 'computer.use',
        status: 'success',
        output: {
          job_id: 'cujob_meta_1',
          status: 'completed',
          transport: 'mcp_stdio',
          provider: 'openai_byok',
          provider_mode: 'github_models',
          planner_model_selected: 'openai/gpt-5-nano',
          planner_model_attempts: 1
        }
      }],
      meta: { request_id: 'rid_meta_model' },
      latency_ms: 8
    },
    requestId: 'rid_meta_model',
    client: 'web',
    runtimeConfig: { response: { exposeDebugMeta: false } },
    engineMeta: { primary: 'v2', mode: 'v2', percent: 100, bucket: 17 },
    latencyMs: 8
  });

  const payload = parseHttpJsonBody(resp);
  assert.equal(payload.meta.computer_use_model, 'openai/gpt-5-nano');
  assert.equal(payload.meta.computer_use_provider_mode, 'github_models');
});
