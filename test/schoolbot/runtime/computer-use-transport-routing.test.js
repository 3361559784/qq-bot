const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { runComputerUseSkill } = require('../../../src/v2/services/computerUseService');
const { shutdownMcpClient } = require('../../../src/v2/services/computerUseMcpClient');

const fixture = path.resolve(__dirname, '../../fixtures/mcp-mock-server.js');

function makeCmd(mode) {
  return `node \"${fixture}\" --mode=${mode}`;
}

function setEnv(temp) {
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

test('computer-use routing: mcp_stdio uses MCP transport', async () => {
  const restore = setEnv({
    COSMOS_DB_STRING: '',
    ARIS_RUNTIME_PROFILE: 'host',
    ARIS_CU_ENABLED: 'true',
    ARIS_CU_TRANSPORT: 'mcp_stdio',
    ARIS_CU_MCP_SERVER_CMD: makeCmd('normal'),
    ARIS_CU_MCP_SERVER_CWD: process.cwd(),
    ARIS_CU_MCP_TIMEOUT_MS: '3000',
  });

  const out = await runComputerUseSkill({
    objective: 'routing mcp',
    request_id: 'rid_transport_mcp',
    user_id: 'u_transport',
    context_id: 'ctx_transport'
  });

  assert.equal(out.transport, 'mcp_stdio');
  restore();
});

test('computer-use routing: http_agent keeps legacy queue transport', async () => {
  const restore = setEnv({
    COSMOS_DB_STRING: '',
    ARIS_RUNTIME_PROFILE: 'host',
    ARIS_CU_ENABLED: 'true',
    ARIS_CU_TRANSPORT: 'http_agent',
    ARIS_CU_SYNC_WAIT_MS: '1000'
  });

  const out = await runComputerUseSkill({
    objective: 'routing http',
    request_id: 'rid_transport_http',
    user_id: 'u_transport_http',
    context_id: 'ctx_transport_http'
  });

  assert.equal(out.transport, 'http_agent');
  restore();
});

test('computer-use routing: hybrid falls back to http_agent when mcp fails', async () => {
  const restore = setEnv({
    COSMOS_DB_STRING: '',
    ARIS_RUNTIME_PROFILE: 'host',
    ARIS_CU_ENABLED: 'true',
    ARIS_CU_TRANSPORT: 'hybrid',
    ARIS_CU_MCP_SERVER_CMD: makeCmd('normal'),
    ARIS_CU_MCP_SERVER_CWD: process.cwd(),
    ARIS_CU_MCP_TIMEOUT_MS: '3000',
    ARIS_CU_SYNC_WAIT_MS: '1000'
  });

  const out = await runComputerUseSkill({
    objective: 'force_mcp_fail',
    request_id: 'rid_transport_hybrid',
    user_id: 'u_transport_hybrid',
    context_id: 'ctx_transport_hybrid'
  });

  assert.equal(out.transport, 'http_agent');
  assert.equal(out.provider_fallback_used, true);
  assert.equal(Array.isArray(out.provider_error_chain), true);
  restore();
});
