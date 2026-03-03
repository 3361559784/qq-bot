const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createComputerUseJob,
  leaseNextComputerUseJob,
  reportComputerUseProgress,
  confirmComputerUseJob,
  listComputerUseJobs,
  cancelComputerUseJob
} = require('../../../src/v2/services/computerUseQueue');

async function cleanupPendingJobs() {
  const jobs = await listComputerUseJobs(500);
  for (const job of jobs) {
    if (['completed', 'failed', 'cancelled'].includes(job.status)) continue;
    // eslint-disable-next-line no-await-in-loop
    await cancelComputerUseJob(job.id, 'test_cleanup');
  }
}

test('computer-use queue: lease and waiting_confirmation flow', async () => {
  const prevCosmos = process.env.COSMOS_DB_STRING;
  process.env.COSMOS_DB_STRING = '';
  await cleanupPendingJobs();

  const rid = `rid_q_${Date.now()}`;
  const job = await createComputerUseJob({
    request_id: rid,
    user_id: 'u_queue',
    context_id: 'ctx_queue',
    objective: '打开系统设置',
    confirm_mode: 'periodic',
    confirm_every_steps: 1,
    step_max_retry: 2,
    max_steps: 10
  });

  const leased = await leaseNextComputerUseJob({
    agentId: 'agent_q',
    leaseTtlSec: 45
  });

  assert.equal(leased.id, job.id);
  assert.equal(typeof leased.lease.lease_token, 'string');

  const report = await reportComputerUseProgress({
    job_id: job.id,
    agent_id: 'agent_q',
    lease_token: leased.lease.lease_token,
    report_type: 'step',
    step: {
      index: 0,
      action: 'click',
      status: 'success',
      duration_ms: 120
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.job.status, 'waiting_confirmation');
  assert.equal(report.job.steps_executed, 1);
  assert.equal(report.job.lease, null);

  const confirmed = await confirmComputerUseJob(job.id);
  assert.equal(confirmed.status, 'queued');

  if (prevCosmos === undefined) delete process.env.COSMOS_DB_STRING;
  else process.env.COSMOS_DB_STRING = prevCosmos;
});

test('computer-use queue: step retry exhausted should fail job', async () => {
  const prevCosmos = process.env.COSMOS_DB_STRING;
  process.env.COSMOS_DB_STRING = '';
  await cleanupPendingJobs();

  const rid = `rid_retry_${Date.now()}`;
  const job = await createComputerUseJob({
    request_id: rid,
    user_id: 'u_retry',
    context_id: 'ctx_retry',
    objective: '点击不存在的按钮',
    confirm_mode: 'never',
    step_max_retry: 1,
    max_steps: 10
  });

  const leased = await leaseNextComputerUseJob({
    agentId: 'agent_retry',
    leaseTtlSec: 45
  });
  assert.equal(leased.id, job.id);

  const firstFail = await reportComputerUseProgress({
    job_id: job.id,
    agent_id: 'agent_retry',
    lease_token: leased.lease.lease_token,
    report_type: 'step',
    step: {
      index: 0,
      action: 'click',
      status: 'failed',
      retry_count: 0,
      error: 'target_not_found'
    }
  });
  assert.equal(firstFail.ok, true);
  assert.equal(firstFail.job.status, 'running');

  const secondFail = await reportComputerUseProgress({
    job_id: job.id,
    agent_id: 'agent_retry',
    lease_token: leased.lease.lease_token,
    report_type: 'step',
    step: {
      index: 1,
      action: 'click',
      status: 'failed',
      retry_count: 1,
      error: 'target_not_found'
    }
  });

  assert.equal(secondFail.ok, true);
  assert.equal(secondFail.job.status, 'failed');
  assert.equal(secondFail.job.error, 'target_not_found');

  if (prevCosmos === undefined) delete process.env.COSMOS_DB_STRING;
  else process.env.COSMOS_DB_STRING = prevCosmos;
});
