const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createComputerUseJob,
  leaseNextComputerUseJob,
  reportComputerUseProgress,
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

test('computer-use confirm: periodic mode confirms every 5 steps', async () => {
  const prevCosmos = process.env.COSMOS_DB_STRING;
  process.env.COSMOS_DB_STRING = '';
  await cleanupPendingJobs();

  const job = await createComputerUseJob({
    request_id: `rid_confirm_${Date.now()}`,
    user_id: 'u_confirm',
    context_id: 'ctx_confirm',
    objective: '连续执行多步',
    confirm_mode: 'periodic',
    confirm_every_steps: 5,
    step_max_retry: 2,
    max_steps: 30
  });

  const leased = await leaseNextComputerUseJob({
    agentId: 'agent_confirm',
    leaseTtlSec: 45
  });
  assert.equal(leased.id, job.id);

  let current = leased;
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const out = await reportComputerUseProgress({
      job_id: job.id,
      agent_id: 'agent_confirm',
      lease_token: current.lease.lease_token,
      report_type: 'step',
      step: {
        index: i,
        action: 'click',
        status: 'success',
        duration_ms: 20
      }
    });
    current = out.job;
  }

  assert.equal(current.steps_executed, 5);
  assert.equal(current.status, 'waiting_confirmation');

  if (prevCosmos === undefined) delete process.env.COSMOS_DB_STRING;
  else process.env.COSMOS_DB_STRING = prevCosmos;
});

test('computer-use confirm: never mode should not pause', async () => {
  const prevCosmos = process.env.COSMOS_DB_STRING;
  process.env.COSMOS_DB_STRING = '';
  await cleanupPendingJobs();

  const job = await createComputerUseJob({
    request_id: `rid_never_${Date.now()}`,
    user_id: 'u_never',
    context_id: 'ctx_never',
    objective: '全自动执行',
    confirm_mode: 'never',
    confirm_every_steps: 5,
    step_max_retry: 2,
    max_steps: 30
  });

  const leased = await leaseNextComputerUseJob({
    agentId: 'agent_never',
    leaseTtlSec: 45
  });
  assert.equal(leased.id, job.id);

  const out = await reportComputerUseProgress({
    job_id: job.id,
    agent_id: 'agent_never',
    lease_token: leased.lease.lease_token,
    report_type: 'step',
    step: {
      index: 0,
      action: 'click',
      status: 'success',
      duration_ms: 20
    }
  });

  assert.equal(out.job.status, 'running');
  assert.equal(out.job.steps_executed, 1);

  if (prevCosmos === undefined) delete process.env.COSMOS_DB_STRING;
  else process.env.COSMOS_DB_STRING = prevCosmos;
});
