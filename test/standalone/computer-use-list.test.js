const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../../src/standalone/app');

function parse(resp) {
  return JSON.parse(resp.body || '{}');
}

test('computer-use list endpoint supports limit/status/user_id filters', async () => {
  const prev = {
    DATABASE_URL: process.env.DATABASE_URL,
    ARIS_RUNTIME_PROFILE: process.env.ARIS_RUNTIME_PROFILE,
    ARIS_CU_ENABLED: process.env.ARIS_CU_ENABLED,
    ARIS_CU_TRANSPORT: process.env.ARIS_CU_TRANSPORT,
    ARIS_CU_SYNC_WAIT_MS: process.env.ARIS_CU_SYNC_WAIT_MS
  };

  process.env.DATABASE_URL = '';
  process.env.ARIS_RUNTIME_PROFILE = 'host';
  process.env.ARIS_CU_ENABLED = 'true';
  process.env.ARIS_CU_TRANSPORT = 'http_agent';
  process.env.ARIS_CU_SYNC_WAIT_MS = '50';

  const app = createApp({
    logger: false,
    auth: { disabled: true }
  });

  try {
    const create1 = await app.inject({
      method: 'POST',
      url: '/api/v3/computer-use/jobs',
      payload: {
        objective: 'list test 1',
        user_id: 'user_a',
        context_id: 'ctx_a'
      }
    });
    assert.equal(create1.statusCode, 201);
    const job1 = parse(create1).job;

    const create2 = await app.inject({
      method: 'POST',
      url: '/api/v3/computer-use/jobs',
      payload: {
        objective: 'list test 2',
        user_id: 'user_b',
        context_id: 'ctx_b'
      }
    });
    assert.equal(create2.statusCode, 201);
    const job2 = parse(create2).job;

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v3/computer-use/jobs/${job1.id}/cancel`,
      payload: { reason: 'test_cancel' }
    });
    assert.equal(cancelled.statusCode, 200);

    const listAll = await app.inject({
      method: 'GET',
      url: '/api/v3/computer-use/jobs?limit=2'
    });
    assert.equal(listAll.statusCode, 200);
    const allBody = parse(listAll);
    assert.equal(allBody.success, true);
    assert.ok(allBody.count >= 2);

    const listCancelled = await app.inject({
      method: 'GET',
      url: '/api/v3/computer-use/jobs?status=cancelled&user_id=user_a&limit=10'
    });
    assert.equal(listCancelled.statusCode, 200);
    const cancelledBody = parse(listCancelled);
    assert.equal(cancelledBody.success, true);
    assert.equal(cancelledBody.items.length, 1);
    assert.equal(cancelledBody.items[0].id, job1.id);

    const listRunning = await app.inject({
      method: 'GET',
      url: '/api/v3/computer-use/jobs?status=queued&user_id=user_b&limit=10'
    });
    assert.equal(listRunning.statusCode, 200);
    const runningBody = parse(listRunning);
    assert.equal(runningBody.success, true);
    assert.ok(runningBody.items.some((x) => x.id === job2.id));

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v3/computer-use/jobs?status=bad_status'
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
    Object.entries(prev).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  }
});
