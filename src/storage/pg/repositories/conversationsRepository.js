const base = require('./baseRepository');

const STORE_NAME = __filename.split('/').pop().replace('Repository.js','').replace('computerUseJobs','computerUseJobs');

function resolveStoreName() {
  if (STORE_NAME === 'conversations') return 'conversations';
  if (STORE_NAME === 'memory') return 'memory';
  if (STORE_NAME === 'skills') return 'skills';
  if (STORE_NAME === 'tasks') return 'tasks';
  if (STORE_NAME === 'computerUseJobs') return 'computerUseJobs';
  if (STORE_NAME === 'audit') return 'audit';
  return STORE_NAME;
}

module.exports = {
  upsert: (partitionKey, doc) => base.upsert(resolveStoreName(), partitionKey, doc),
  getById: (partitionKey, id) => base.getById(resolveStoreName(), partitionKey, id),
  listByPartition: (partitionKey, limit) => base.listByPartition(resolveStoreName(), partitionKey, limit),
  listStore: (limit, offset) => base.listStore(resolveStoreName(), limit, offset),
  remove: (partitionKey, id) => base.remove(resolveStoreName(), partitionKey, id)
};
