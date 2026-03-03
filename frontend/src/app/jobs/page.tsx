'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import styles from './page.module.css';

type Job = {
  id: string;
  objective: string;
  status: string;
  summary?: string;
  user_id?: string;
  provider?: string;
  provider_mode?: string;
  planner_model_selected?: string;
  planner_model_attempts?: number;
  updated_at?: string;
};

const STATUS_OPTIONS = ['', 'queued', 'leased', 'running', 'waiting_confirmation', 'completed', 'failed', 'cancelled'];

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [objective, setObjective] = useState('');
  const [creating, setCreating] = useState(false);

  const title = useMemo(() => (statusFilter ? `Jobs (${statusFilter})` : 'Jobs (all)'), [statusFilter]);

  async function loadJobs() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (statusFilter) params.set('status', statusFilter);
      const response = await fetch(`/api/computer-use/jobs?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || data.error || 'load_jobs_failed');
      setJobs(Array.isArray(data.items) ? data.items : []);
      setError('');
    } catch (err) {
      setError(String((err as Error)?.message || err || 'load_jobs_failed'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadJobs();
    const timer = setInterval(loadJobs, 5000);
    return () => clearInterval(timer);
  }, [statusFilter]);

  async function createJob(event: FormEvent) {
    event.preventDefault();
    const text = objective.trim();
    if (!text || creating) return;

    setCreating(true);
    try {
      const response = await fetch('/api/computer-use/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          objective: text,
          user_id: 'web_ui_user',
          context_id: 'web_ui_session',
          trigger: 'web_ui'
        })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || data.error || 'create_job_failed');
      setObjective('');
      await loadJobs();
    } catch (err) {
      setError(String((err as Error)?.message || err || 'create_job_failed'));
    } finally {
      setCreating(false);
    }
  }

  async function mutateJob(id: string, action: 'confirm' | 'cancel') {
    try {
      const response = await fetch(`/api/computer-use/jobs/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: action === 'cancel' ? JSON.stringify({ reason: 'cancelled_from_ui' }) : '{}'
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || data.error || `${action}_job_failed`);
      await loadJobs();
    } catch (err) {
      setError(String((err as Error)?.message || err || `${action}_job_failed`));
    }
  }

  return (
    <section className={styles.wrap}>
      <div className={styles.toolbar}>
        <div>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.desc}>默认每 5 秒自动刷新，支持确认与取消任务。</p>
        </div>

        <div className={styles.filterGroup}>
          <label htmlFor="status">Status</label>
          <select id="status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s || 'all'} value={s}>{s || 'all'}</option>
            ))}
          </select>
          <button type="button" onClick={loadJobs} disabled={loading}>Refresh</button>
        </div>
      </div>

      <form onSubmit={createJob} className={styles.createBox}>
        <input
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="创建一个 computer-use 任务，例如：打开系统设置并进入蓝牙页面"
        />
        <button type="submit" disabled={creating || !objective.trim()}>{creating ? 'Creating…' : 'Create Job'}</button>
      </form>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.list}>
        {jobs.length === 0 ? (
          <div className={styles.empty}>暂无任务</div>
        ) : jobs.map((job) => (
          <article key={job.id} className={styles.item}>
            <header className={styles.itemTop}>
              <div className={styles.itemId}>{job.id}</div>
              <div className={`${styles.status} ${styles[`status_${job.status}`] || ''}`}>{job.status}</div>
            </header>

            <div className={styles.objective}>{job.objective}</div>
            <div className={styles.meta}>
              <span>provider={job.provider || 'unknown'}</span>
              <span>mode={job.provider_mode || 'unknown'}</span>
              <span>model={job.planner_model_selected || '-'}</span>
              <span>attempts={job.planner_model_attempts ?? 0}</span>
            </div>
            {job.summary ? <div className={styles.summary}>{job.summary}</div> : null}
            <div className={styles.updated}>{job.updated_at || '-'}</div>

            <div className={styles.actions}>
              <button
                type="button"
                onClick={() => mutateJob(job.id, 'confirm')}
                disabled={job.status !== 'waiting_confirmation'}
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => mutateJob(job.id, 'cancel')}
                disabled={job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed'}
              >
                Cancel
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
