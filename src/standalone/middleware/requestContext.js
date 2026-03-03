function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function attachRequestContext(request, _reply, done) {
  const requestId = String(request.headers['x-request-id'] || generateRequestId());

  request.ctx = {
    requestId,
    log: (...args) => request.log.info({ requestId }, args.map(String).join(' ')),
    warn: (...args) => request.log.warn({ requestId }, args.map(String).join(' ')),
    error: (...args) => request.log.error({ requestId }, args.map(String).join(' '))
  };

  done();
}

module.exports = {
  attachRequestContext
};
