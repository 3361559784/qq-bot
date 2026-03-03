const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { callMcpTool, shutdownMcpClient } = require('../../../src/v2/services/computerUseMcpClient');

const fixture = path.resolve(__dirname, '../../fixtures/mcp-mock-server.js');

function makeCmd(mode) {
  return `node \"${fixture}\" --mode=${mode}`;
}

test.afterEach(async () => {
  await shutdownMcpClient();
});

test('mcp client: stdio handshake and tool call success', async () => {
  const out = await callMcpTool('run_task', {
    objective: 'open settings'
  }, {
    cmd: makeCmd('stderr-noise'),
    cwd: process.cwd(),
    timeoutMs: 3000
  });

  assert.equal(out.status, 'completed');
  assert.equal(out.provider, 'openai_byok');
});

test('mcp client: timeout is raised when server does not respond', async () => {
  await assert.rejects(
    () => callMcpTool('run_task', { objective: 'timeout' }, {
      cmd: makeCmd('timeout'),
      cwd: process.cwd(),
      timeoutMs: 600
    }),
    /mcp_timeout/
  );
});

test('mcp client: process crash can recover on next healthy server', async () => {
  await assert.rejects(
    () => callMcpTool('run_task', { objective: 'crash now' }, {
      cmd: makeCmd('crash'),
      cwd: process.cwd(),
      timeoutMs: 1500
    })
  );

  const ok = await callMcpTool('run_task', { objective: 'recover' }, {
    cmd: makeCmd('normal'),
    cwd: process.cwd(),
    timeoutMs: 3000
  });

  assert.equal(ok.status, 'completed');
});
