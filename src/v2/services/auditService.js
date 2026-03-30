const { generateId, nowIso } = require('../utils');
const { upsertDoc, listDocs } = require('./storage');

async function logAudit(event, payload = {}, context = null) {
  const doc = {
    id: generateId('audit'),
    event,
    payload,
    created_at: nowIso()
  };
  const partitionKey = payload.request_id || payload.user_id || 'global';
  await upsertDoc('audit', partitionKey, doc, context);
  return doc;
}

async function recentAudit(limit = 50, context = null) {
  return listDocs('audit', 'global', { limit }, context);
}

module.exports = {
  logAudit,
  recentAudit
};
