const { CosmosClient } = require('@azure/cosmos');
const { V2_DEFAULTS } = require('../constants');

let cached = null;

const inMemory = {
  conversations: new Map(),
  memory: new Map(),
  skills: new Map(),
  tasks: new Map(),
  computerUseJobs: new Map(),
  audit: []
};

async function initCosmos(context = null) {
  if (cached) return cached;

  const conn = process.env.COSMOS_DB_STRING;
  if (!conn) {
    cached = { enabled: false, containers: null, memory: inMemory };
    return cached;
  }

  try {
    const client = new CosmosClient(conn);
    const { database } = await client.databases.createIfNotExists({ id: V2_DEFAULTS.db.database });

    const create = async (id) => {
      const { container } = await database.containers.createIfNotExists({
        id,
        partitionKey: { paths: ['/partitionKey'] }
      });
      return container;
    };

    cached = {
      enabled: true,
      containers: {
        conversations: await create(V2_DEFAULTS.db.containers.conversations),
        memory: await create(V2_DEFAULTS.db.containers.memory),
        skills: await create(V2_DEFAULTS.db.containers.skills),
        tasks: await create(V2_DEFAULTS.db.containers.tasks),
        computerUseJobs: await create(V2_DEFAULTS.db.containers.computerUseJobs),
        audit: await create(V2_DEFAULTS.db.containers.audit)
      },
      memory: inMemory
    };
    return cached;
  } catch (err) {
    context?.log?.(`[v2/storage] cosmos init failed: ${err.message}`);
    cached = { enabled: false, containers: null, memory: inMemory };
    return cached;
  }
}

function mapStore(memoryStore, key) {
  if (!memoryStore.has(key)) memoryStore.set(key, []);
  return memoryStore.get(key);
}

async function upsertDoc(storeName, partitionKey, doc, context = null) {
  const state = await initCosmos(context);
  const fullDoc = { ...doc, partitionKey };

  if (state.enabled) {
    await state.containers[storeName].items.upsert(fullDoc);
    return fullDoc;
  }

  if (storeName === 'skills') {
    state.memory.skills.set(doc.id, fullDoc);
    return fullDoc;
  }
  if (storeName === 'tasks') {
    state.memory.tasks.set(doc.id, fullDoc);
    return fullDoc;
  }
  if (storeName === 'computerUseJobs') {
    state.memory.computerUseJobs.set(doc.id, fullDoc);
    return fullDoc;
  }
  if (storeName === 'audit') {
    state.memory.audit.push(fullDoc);
    return fullDoc;
  }

  const key = `${storeName}:${partitionKey}`;
  const list = mapStore(state.memory[storeName], key);
  const idx = list.findIndex((x) => x.id === doc.id);
  if (idx >= 0) list[idx] = fullDoc;
  else list.push(fullDoc);
  return fullDoc;
}

async function readDoc(storeName, id, partitionKey, context = null) {
  const state = await initCosmos(context);
  if (state.enabled) {
    try {
      const { resource } = await state.containers[storeName].item(id, partitionKey).read();
      return resource || null;
    } catch (err) {
      const code = err.code || err.statusCode;
      if (code === 404) return null;
      throw err;
    }
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
  const { limit = 100, where = '' } = options;

  if (state.enabled) {
    const query = {
      query: `SELECT TOP ${Number(limit)} * FROM c WHERE c.partitionKey = @pk ${where ? `AND ${where}` : ''}`,
      parameters: [{ name: '@pk', value: partitionKey }]
    };
    const { resources } = await state.containers[storeName].items.query(query).fetchAll();
    return resources || [];
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
    try {
      await state.containers[storeName].item(id, partitionKey).delete();
      return true;
    } catch (err) {
      const code = err.code || err.statusCode;
      if (code === 404) return false;
      throw err;
    }
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
