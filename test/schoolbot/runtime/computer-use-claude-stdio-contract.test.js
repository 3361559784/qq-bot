const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { listMcpTools, callMcpTool, shutdownMcpClient } = require('../../../src/v2/services/computerUseMcpClient');

const serverCwd = path.resolve(process.cwd(), 'local/mcp-computer-use-server');

function hasPython3() {
  const out = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  return out.status === 0;
}

test.afterEach(async () => {
  await shutdownMcpClient();
});

test('claude stdio contract: tools/list exposes expected computer-use tools', async (t) => {
  if (!hasPython3()) {
    t.skip('python3 is not available');
    return;
  }

  const tools = await listMcpTools({
    cmd: 'python3 main.py',
    cwd: serverCwd,
    timeoutMs: 5000,
    env: {
      ARIS_CU_PROVIDER_MOCK: 'true',
      ARIS_CU_EXECUTOR_DRY_RUN: 'true',
      ARIS_CU_RELAY_ENABLE_DEV: 'false'
    }
  });

  const names = tools.map((x) => x.name).sort();
  const expected = ['click', 'double_click', 'hotkey', 'right_click', 'run_task', 'screenshot', 'scroll', 'type', 'wait'];
  assert.deepEqual(names, expected);
});

test('claude stdio contract: run_task returns structured MCP payload', async (t) => {
  if (!hasPython3()) {
    t.skip('python3 is not available');
    return;
  }

  const out = await callMcpTool('run_task', {
    objective: 'mock run task',
    max_steps: 5,
    step_max_retry: 1,
    confirm_mode: 'never',
    allow_relay: false
  }, {
    cmd: 'python3 main.py',
    cwd: serverCwd,
    timeoutMs: 5000,
    env: {
      ARIS_CU_PROVIDER_MOCK: 'true',
      ARIS_CU_EXECUTOR_DRY_RUN: 'true',
      ARIS_CU_RELAY_ENABLE_DEV: 'false'
    }
  });

  assert.equal(typeof out.status, 'string');
  assert.equal(typeof out.provider, 'string');
  assert.equal(typeof out.provider_attempts, 'number');
  assert.equal(Array.isArray(out.provider_error_chain), true);
});
