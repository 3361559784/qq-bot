const fs = require('fs');
const path = require('path');
const { query } = require('../../src/storage/pg/client');

async function ensureMigrationTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS migration_runs (
      id BIGSERIAL PRIMARY KEY,
      migration_name TEXT NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function hasMigration(name) {
  const res = await query('SELECT 1 FROM migration_runs WHERE migration_name = $1 LIMIT 1', [name]);
  return res.rowCount > 0;
}

async function markMigration(name) {
  await query('INSERT INTO migration_runs (migration_name) VALUES ($1) ON CONFLICT (migration_name) DO NOTHING', [name]);
}

async function main() {
  const dir = path.resolve(process.cwd(), 'db/migrations');
  const files = fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
  if (!files.length) {
    // eslint-disable-next-line no-console
    console.log('no_sql_migrations_found');
    return;
  }

  await ensureMigrationTable();

  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const done = await hasMigration(file);
    if (done) {
      // eslint-disable-next-line no-console
      console.log(`skip ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    // eslint-disable-next-line no-await-in-loop
    await query(sql);
    // eslint-disable-next-line no-await-in-loop
    await markMigration(file);
    // eslint-disable-next-line no-console
    console.log(`applied ${file}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
