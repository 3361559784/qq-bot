const test = require('node:test');
const assert = require('node:assert/strict');
const { runComputerUseSkill } = require('../../../src/v2/services/computerUseService');

test('computer-use cloud degrade: server mode without remote executor', async () => {
  const prevProfile = process.env.ARIS_RUNTIME_PROFILE;
  const prevEnabled = process.env.ARIS_CU_ENABLED;
  const prevRemote = process.env.ARIS_CU_REMOTE_ENDPOINT;

  process.env.ARIS_RUNTIME_PROFILE = 'server';
  process.env.ARIS_CU_ENABLED = 'true';
  process.env.ARIS_CU_REMOTE_ENDPOINT = '';

  const out = await runComputerUseSkill({
    objective: '打开系统设置',
    request_id: 'rid_server_degrade',
    user_id: 'u1',
    context_id: 'ctx1'
  });

  assert.equal(out.success, false);
  assert.equal(out.status, 'degraded');
  assert.equal(out.error, 'server_no_local_executor');

  if (prevProfile === undefined) delete process.env.ARIS_RUNTIME_PROFILE;
  else process.env.ARIS_RUNTIME_PROFILE = prevProfile;

  if (prevEnabled === undefined) delete process.env.ARIS_CU_ENABLED;
  else process.env.ARIS_CU_ENABLED = prevEnabled;

  if (prevRemote === undefined) delete process.env.ARIS_CU_REMOTE_ENDPOINT;
  else process.env.ARIS_CU_REMOTE_ENDPOINT = prevRemote;
});

