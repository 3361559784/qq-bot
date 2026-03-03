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

test('model fallback chain: gpt-5-nano fallback result is surfaced in tool output', async () => {
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
    objective: 'model_fallback',
    request_id: 'rid_model_fallback',
    user_id: 'u_model_fallback',
    context_id: 'ctx_model_fallback'
  });

  assert.equal(out.success, true);
  assert.equal(out.provider, 'openai_byok');
  assert.equal(out.provider_mode, 'github_models');
  assert.equal(out.planner_model_selected, 'openai/gpt-4.1-mini');
  assert.equal(out.planner_model_attempts, 2);
  assert.equal(Array.isArray(out.provider_error_chain), true);
  assert.ok(out.provider_error_chain.some((x) => x.code === 'model_not_found'));
  restore();
});
