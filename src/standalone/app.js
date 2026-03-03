const Fastify = require('fastify');
const { attachRequestContext } = require('./middleware/requestContext');
const { createAuthMiddleware } = require('./middleware/auth');
const { v3Routes } = require('./routes/v3');

function createApp(options = {}) {
  const fastify = Fastify({
    logger: options.logger ?? true,
    trustProxy: true,
    bodyLimit: Number(process.env.ARIS_BODY_LIMIT || 1024 * 1024)
  });

  fastify.addHook('onRequest', attachRequestContext);
  fastify.addHook('preHandler', createAuthMiddleware(options.auth || {}));

  fastify.get('/healthz', async () => ({ ok: true, service: 'schoolbot-api', version: 'v3' }));
  fastify.get('/readyz', async () => ({ ok: true }));

  fastify.register(v3Routes, { prefix: '/api/v3' });

  fastify.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, 'unhandled_error');
    if (reply.sent) return;
    reply.code(500).send({ error: 'internal_error', message: err.message });
  });

  return fastify;
}

module.exports = {
  createApp
};
