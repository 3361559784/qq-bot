const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { runComputerUseSkill } = require('../../../src/v2/services/computerUseService');
const { shutdownMcpClient } = require('../../../src/v2/services/computerUseMcpClient');

const fixture = path.resolve(__dirname, '../../fixtures/mcp-mock-server.js');

function makeCmd(mode) {
  return `node \"${fixture}\" --mode=${mode}`;
}

function withEnv(temp) {
  const prev = {};
  for (const [k, v] of Object.entries(temp)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test.afterEach(async () => {
  await shutdownMcpClient();
});

test('provider chain: relay fallback is observable after model-chain failures', async () => {
  const restore = withEnv({
    COSMOS_DB_STRING: '',
    ARIS_RUNTIME_PROFILE: 'host',
    ARIS_CU_ENABLED: 'true',
    ARIS_CU_TRANSPORT: 'mcp_stdio',
    ARIS_CU_MCP_SERVER_CMD: makeCmd('normal'),
    ARIS_CU_MCP_SERVER_CWD: process.cwd(),
    ARIS_CU_MCP_TIMEOUT_MS: '3000',
    ARIS_CU_RELAY_ENABLE_DEV: 'true'
  });

  const out = await runComputerUseSkill({
    objective: 'plus_fallback',
    request_id: 'rid_plus_fallback_after_models',
    user_id: 'u_plus_fallback_after_models',
    context_id: 'ctx_plus_fallback_after_models'
  });

  assert.equal(out.success, true);
  assert.equal(out.provider, 'chatgpt_plus_relay_poc');
  assert.equal(out.provider_mode, 'relay_poc');
  assert.equal(out.provider_fallback_used, true);
  assert.equal(Array.isArray(out.provider_error_chain), true);
  assert.ok(out.provider_error_chain.some((x) => x.code === 'model_not_found'));
  assert.ok(out.provider_error_chain.some((x) => x.code === 'rate_limited'));
  restore();
});
