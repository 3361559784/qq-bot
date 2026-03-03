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

test('provider chain: BYOK success does not fallback', async () => {
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
    objective: 'provider byok success',
    request_id: 'rid_provider_byok',
    user_id: 'u_provider',
    context_id: 'ctx_provider'
  });

  assert.equal(out.provider, 'openai_byok');
  assert.equal(out.provider_fallback_used, false);
  assert.equal(out.provider_attempts, 1);
  restore();
});

test('provider chain: BYOK failure can fallback to relay provider', async () => {
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
    request_id: 'rid_provider_fallback',
    user_id: 'u_provider_fallback',
    context_id: 'ctx_provider_fallback'
  });

  assert.equal(out.provider, 'chatgpt_plus_relay_poc');
  assert.equal(out.provider_fallback_used, true);
  assert.equal(out.provider_attempts, 2);
  assert.equal(Array.isArray(out.provider_error_chain), true);
  assert.ok(out.provider_error_chain.length >= 1);
  restore();
});

test('provider chain: provider failure returns observable error chain', async () => {
  const restore = withEnv({
    COSMOS_DB_STRING: '',
    ARIS_RUNTIME_PROFILE: 'host',
    ARIS_CU_ENABLED: 'true',
    ARIS_CU_TRANSPORT: 'mcp_stdio',
    ARIS_CU_MCP_SERVER_CMD: makeCmd('normal'),
    ARIS_CU_MCP_SERVER_CWD: process.cwd(),
    ARIS_CU_MCP_TIMEOUT_MS: '3000'
  });

  const out = await runComputerUseSkill({
    objective: 'force_mcp_fail',
    request_id: 'rid_provider_fail',
    user_id: 'u_provider_fail',
    context_id: 'ctx_provider_fail'
  });

  assert.equal(out.success, false);
  assert.equal(Array.isArray(out.provider_error_chain), true);
  assert.ok(out.provider_error_chain.length >= 1);
  restore();
});
