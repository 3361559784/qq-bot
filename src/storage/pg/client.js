const { Pool } = require('pg');

let pool = null;

function getDatabaseUrl(env = process.env) {
  return String(env.DATABASE_URL || '').trim();
}

function isPgEnabled(env = process.env) {
  return !!getDatabaseUrl(env);
}

function getPool(env = process.env) {
  if (!isPgEnabled(env)) return null;
  if (pool) return pool;

  pool = new Pool({
    connectionString: getDatabaseUrl(env),
    ssl: String(env.PG_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined,
    max: Number(env.PG_POOL_MAX || 20),
    idleTimeoutMillis: Number(env.PG_IDLE_TIMEOUT_MS || 30000)
  });
  return pool;
}

async function query(sql, params = [], env = process.env) {
  const p = getPool(env);
  if (!p) throw new Error('postgres_not_configured');
  return p.query(sql, params);
}

async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

module.exports = {
  getDatabaseUrl,
  isPgEnabled,
  getPool,
  query,
  closePool
};
