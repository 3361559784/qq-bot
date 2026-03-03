import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as jobsGet, POST as jobsPost } from '../src/app/api/computer-use/jobs/route';
import { POST as confirmPost } from '../src/app/api/computer-use/jobs/[id]/confirm/route';
import { POST as cancelPost } from '../src/app/api/computer-use/jobs/[id]/cancel/route';

function setProxyEnv() {
  process.env.ARIS_API_INTERNAL_BASE_URL = 'http://api:3000';
  process.env.ARIS_AUTH_KEY = 'proxy_key';
  process.env.ARIS_AUTH_SIGNATURE_SECRET = 'proxy_secret';
  process.env.ARIS_PROXY_TIMEOUT_MS = '1000';
}

test('computer-use jobs GET/POST proxy routes forward correctly', async () => {
  setProxyEnv();
  const prevFetch = global.fetch;
  const hitUrls: string[] = [];

  global.fetch = (async (url: string | URL | Request) => {
    hitUrls.push(String(url));
    return new Response(JSON.stringify({ success: true, items: [], job: { id: 'job_1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }) as typeof fetch;

  try {
    const getReq = new Request('http://localhost/api/computer-use/jobs?status=queued&limit=10', { method: 'GET' });
    const getRes = await jobsGet(getReq);
    assert.equal(getRes.status, 200);

    const postReq = new Request('http://localhost/api/computer-use/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'open app' })
    });
    const postRes = await jobsPost(postReq);
    assert.equal(postRes.status, 200);

    assert.ok(hitUrls.some((x) => x.includes('/api/v3/computer-use/jobs?status=queued&limit=10')));
    assert.ok(hitUrls.some((x) => x.endsWith('/api/v3/computer-use/jobs')));
  } finally {
    global.fetch = prevFetch;
  }
});

test('computer-use confirm/cancel routes include job id in backend path', async () => {
  setProxyEnv();
  const prevFetch = global.fetch;
  const hitUrls: string[] = [];

  global.fetch = (async (url: string | URL | Request) => {
    hitUrls.push(String(url));
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }) as typeof fetch;

  try {
    const confirmReq = new Request('http://localhost/api/computer-use/jobs/job_1/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const confirmRes = await confirmPost(confirmReq, { params: { id: 'job_1' } });
    assert.equal(confirmRes.status, 200);

    const cancelReq = new Request('http://localhost/api/computer-use/jobs/job_1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const cancelRes = await cancelPost(cancelReq, { params: { id: 'job_1' } });
    assert.equal(cancelRes.status, 200);

    assert.ok(hitUrls.some((x) => x.endsWith('/api/v3/computer-use/jobs/job_1/confirm')));
    assert.ok(hitUrls.some((x) => x.endsWith('/api/v3/computer-use/jobs/job_1/cancel')));
  } finally {
    global.fetch = prevFetch;
  }
});
