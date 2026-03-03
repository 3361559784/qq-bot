require('dotenv').config();

const { createApp } = require('./app');
const { initCosmos } = require('../v2/services/storage');

async function start() {
  const port = Number(process.env.ARIS_HTTP_PORT || process.env.PORT || 3000);
  const host = String(process.env.ARIS_HTTP_HOST || '0.0.0.0');

  await initCosmos();

  const app = createApp();
  await app.listen({ port, host });
  app.log.info(`schoolbot standalone api listening on ${host}:${port}`);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
