const { isPgEnabled } = require('../../storage/pg/client');
const baseRepo = require('../../storage/pg/repositories/baseRepository');

let cached = null;

const inMemory = {
  conversations: new Map(),
  memory: new Map(),
  skills: new Map(),
  tasks: new Map(),
  computerUseJobs: new Map(),
  audit: []
};

function mapStore(memoryStore, key) {
  if (!memoryStore.has(key)) memoryStore.set(key, []);
  return memoryStore.get(key);
}

async function initCosmos(context = null) {
  // Compatibility alias: v2 services still call initCosmos.
  if (cached) return cached;

  const pg = isPgEnabled(process.env);
  cached = {
    enabled: pg,
    mode: pg ? 'postgres' : 'memory',
    containers: null,
    memory: inMemory
  };

  context?.log?.(`[v2/storage] initialized mode=${cached.mode}`);
  return cached;
}

function normalizeDoc(doc, partitionKey) {
  return {
    ...(doc || {}),
    partitionKey
  };
}

async function upsertDoc(storeName, partitionKey, doc, context = null) {
  const state = await initCosmos(context);
  const fullDoc = normalizeDoc(doc, partitionKey);

  if (state.enabled) {
    return baseRepo.upsert(storeName, partitionKey, fullDoc);
  }

  if (storeName === 'skills') {
    state.memory.skills.set(fullDoc.id, fullDoc);
    return fullDoc;
  }
  if (storeName === 'tasks') {
    state.memory.tasks.set(fullDoc.id, fullDoc);
    return fullDoc;
  }
  if (storeName === 'computerUseJobs') {
    state.memory.computerUseJobs.set(fullDoc.id, fullDoc);
    return fullDoc;
  }
  if (storeName === 'audit') {
    state.memory.audit.push(fullDoc);
    return fullDoc;
  }

  const key = `${storeName}:${partitionKey}`;
  const list = mapStore(state.memory[storeName], key);
  const idx = list.findIndex((x) => x.id === fullDoc.id);
  if (idx >= 0) list[idx] = fullDoc;
  else list.push(fullDoc);
  return fullDoc;
}

async function readDoc(storeName, id, partitionKey, context = null) {
  const state = await initCosmos(context);
  if (state.enabled) {
    return baseRepo.getById(storeName, partitionKey, id);
  }

  if (storeName === 'skills') return state.memory.skills.get(id) || null;
  if (storeName === 'tasks') return state.memory.tasks.get(id) || null;
  if (storeName === 'computerUseJobs') return state.memory.computerUseJobs.get(id) || null;

  const key = `${storeName}:${partitionKey}`;
  const list = mapStore(state.memory[storeName], key);
  return list.find((x) => x.id === id) || null;
}

async function listDocs(storeName, partitionKey, options = {}, context = null) {
  const state = await initCosmos(context);
  const limit = Number(options.limit || 100);

  if (state.enabled) {
    if (storeName === 'audit' && partitionKey === 'global') {
      return baseRepo.listStore(storeName, limit, 0);
    }
    if (options.where) {
      context?.log?.(`[v2/storage] options.where is ignored in postgres mode: ${options.where}`);
    }
    return baseRepo.listByPartition(storeName, partitionKey, limit);
  }

  if (storeName === 'skills') return Array.from(state.memory.skills.values()).slice(0, limit);
  if (storeName === 'tasks') return Array.from(state.memory.tasks.values()).slice(0, limit);
  if (storeName === 'computerUseJobs') return Array.from(state.memory.computerUseJobs.values()).slice(0, limit);
  if (storeName === 'audit') return state.memory.audit.slice(-limit);

  const key = `${storeName}:${partitionKey}`;
  return mapStore(state.memory[storeName], key).slice(-limit);
}

async function deleteDoc(storeName, id, partitionKey, context = null) {
  const state = await initCosmos(context);
  if (state.enabled) {
    return baseRepo.remove(storeName, partitionKey, id);
  }

  if (storeName === 'skills') return state.memory.skills.delete(id);
  if (storeName === 'tasks') return state.memory.tasks.delete(id);
  if (storeName === 'computerUseJobs') return state.memory.computerUseJobs.delete(id);

  const key = `${storeName}:${partitionKey}`;
  const list = mapStore(state.memory[storeName], key);
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  return true;
}

module.exports = {
  initCosmos,
  upsertDoc,
  readDoc,
  listDocs,
  deleteDoc,
  inMemory
};
