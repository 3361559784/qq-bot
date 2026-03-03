const test = require('node:test');
const assert = require('node:assert/strict');
const {
  v2ComputerUseJobsCreateHandler,
  v2ComputerUseJobGetHandler,
  v2ComputerUseJobConfirmHandler,
  v2ComputerUseJobCancelHandler,
  v2ComputerUseAgentPollHandler,
  v2ComputerUseAgentReportHandler,
  v2ComputerUseAgentHeartbeatHandler
} = require('../../../src/functions/v2Api');

function makeRequest({
  body = {},
  headers = {},
  params = {},
  query = {}
} = {}) {
  const lowered = new Map();
  Object.entries(headers).forEach(([k, v]) => lowered.set(String(k).toLowerCase(), String(v)));
  const text = JSON.stringify(body || {});
  return {
    headers: {
      get: (key) => lowered.get(String(key).toLowerCase()) || null
    },
    params,
    query: {
      get: (key) => query[key] || null
    },
    text: async () => text
  };
}

function parseBody(resp) {
  if (!resp || !resp.body) return null;
  return JSON.parse(resp.body);
}

function makeContext() {
  return {
    log: () => {},
    error: () => {},
    warn: () => {}
  };
}

test('computer-use api: create/get/confirm/cancel contract', async () => {
  const prev = {
    COSMOS_DB_STRING: process.env.COSMOS_DB_STRING,
    ARIS_RUNTIME_PROFILE: process.env.ARIS_RUNTIME_PROFILE,
    ARIS_CU_ENABLED: process.env.ARIS_CU_ENABLED,
    ARIS_CU_SYNC_WAIT_MS: process.env.ARIS_CU_SYNC_WAIT_MS,
    ARIS_CU_AGENT_TOKEN: process.env.ARIS_CU_AGENT_TOKEN
  };

  process.env.COSMOS_DB_STRING = '';
  process.env.ARIS_RUNTIME_PROFILE = 'host';
  process.env.ARIS_CU_ENABLED = 'true';
  process.env.ARIS_CU_SYNC_WAIT_MS = '1000';
  process.env.ARIS_CU_AGENT_TOKEN = 'agent_test_token';

  const ctx = makeContext();
  const createResp = await v2ComputerUseJobsCreateHandler(makeRequest({
    body: {
      request_id: 'rid_api_create',
      user_id: 'u_api',
      context_id: 'ctx_api',
      objective: '打开系统设置并点击蓝牙',
      confirm_mode: 'periodic',
      confirm_every_steps: 1
    }
  }), ctx);

  assert.equal(createResp.status, 201);
  const created = parseBody(createResp);
  assert.equal(created.success, true);
  assert.equal(typeof created.job.id, 'string');

  const pollResp = await v2ComputerUseAgentPollHandler(makeRequest({
    body: { agent_id: 'agent_api' },
    headers: { 'x-aris-agent-token': 'agent_test_token' }
  }), ctx);
  const polled = parseBody(pollResp);
  assert.equal(polled.success, true);
  assert.equal(polled.job.id, created.job.id);
  assert.equal(typeof polled.job.lease.lease_token, 'string');

  const reportResp = await v2ComputerUseAgentReportHandler(makeRequest({
    body: {
      job_id: created.job.id,
      agent_id: 'agent_api',
      lease_token: polled.job.lease.lease_token,
      report_type: 'step',
      step: { index: 0, action: 'click', status: 'success', duration_ms: 30 }
    },
    headers: { 'x-aris-agent-token': 'agent_test_token' }
  }), ctx);
  const reported = parseBody(reportResp);
  assert.equal(reported.success, true);
  assert.equal(reported.job.status, 'waiting_confirmation');

  const confirmResp = await v2ComputerUseJobConfirmHandler(makeRequest({
    params: { id: created.job.id }
  }), ctx);
  const confirmed = parseBody(confirmResp);
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.job.status, 'queued');

  const heartbeatResp = await v2ComputerUseAgentHeartbeatHandler(makeRequest({
    body: { agent_id: 'agent_api' },
    headers: { 'x-aris-agent-token': 'agent_test_token' }
  }), ctx);
  const heartbeat = parseBody(heartbeatResp);
  assert.equal(heartbeat.success, true);

  const cancelResp = await v2ComputerUseJobCancelHandler(makeRequest({
    params: { id: created.job.id },
    body: { reason: 'test_cancel' }
  }), ctx);
  const cancelled = parseBody(cancelResp);
  assert.equal(cancelled.success, true);
  assert.equal(cancelled.job.status, 'cancelled');

  const getResp = await v2ComputerUseJobGetHandler(makeRequest({
    params: { id: created.job.id }
  }), ctx);
  const got = parseBody(getResp);
  assert.equal(got.success, true);
  assert.equal(got.job.status, 'cancelled');

  Object.entries(prev).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
});

test('computer-use api: agent endpoints require token', async () => {
  const prevToken = process.env.ARIS_CU_AGENT_TOKEN;
  process.env.ARIS_CU_AGENT_TOKEN = 'agent_test_token_2';

  const ctx = makeContext();
  const resp = await v2ComputerUseAgentPollHandler(makeRequest({
    body: { agent_id: 'agent_noauth' }
  }), ctx);
  const body = parseBody(resp);
  assert.equal(resp.status, 401);
  assert.equal(body.error, 'agent_unauthorized');

  if (prevToken === undefined) delete process.env.ARIS_CU_AGENT_TOKEN;
  else process.env.ARIS_CU_AGENT_TOKEN = prevToken;
});

