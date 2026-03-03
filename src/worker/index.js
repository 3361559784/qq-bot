require('dotenv').config();

const { initCosmos } = require('../v2/services/storage');
const { startWorkerScheduler } = require('./scheduler');

async function start() {
  const enabled = String(process.env.ARIS_WORKER_ENABLED || 'true').toLowerCase() === 'true';
  if (!enabled) {
    // eslint-disable-next-line no-console
    console.log('[worker] disabled by ARIS_WORKER_ENABLED=false');
    return;
  }

  await initCosmos();

  const context = {
    log: (...args) => console.log('[worker]', ...args),
    warn: (...args) => console.warn('[worker]', ...args),
    error: (...args) => console.error('[worker]', ...args)
  };

  startWorkerScheduler(context);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
