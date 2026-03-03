/* eslint-disable no-console */
const { query } = require('../../src/storage/pg/client');
const { buildStoreMappings, normalizeCosmosDoc } = require('./mapping');

async function getCosmosClient() {
  const conn = String(process.env.COSMOS_DB_STRING || '').trim();
  if (!conn) throw new Error('COSMOS_DB_STRING is required for migration');

  let CosmosClient;
  try {
    ({ CosmosClient } = require('@azure/cosmos'));
  } catch (err) {
    throw new Error('missing @azure/cosmos. Install temporarily: npm i -D @azure/cosmos');
  }

  return new CosmosClient(conn);
}

async function upsertDocument(store, doc) {
  const normalized = normalizeCosmosDoc(store, doc);
  await query(`
    INSERT INTO documents (store_name, partition_key, id, data)
    VALUES ($1, $2, $3, $4::jsonb)
    ON CONFLICT (store_name, partition_key, id)
    DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `, [
    store,
    normalized.partitionKey,
    normalized.id,
    JSON.stringify(normalized)
  ]);
}

async function migrateContainer(client, dbName, mapping) {
  const database = client.database(dbName);
  const container = database.container(mapping.container);

  const sql = 'SELECT * FROM c';
  const iterator = container.items.query({ query: sql, parameters: [] }, { maxItemCount: 100 });

  let migrated = 0;
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { resources = [], hasMoreResults } = await iterator.fetchNext();
    for (const item of resources) {
      // eslint-disable-next-line no-await-in-loop
      await upsertDocument(mapping.store, item);
      migrated += 1;
    }
    if (!hasMoreResults) break;
  }

  return migrated;
}

async function main() {
  const dbName = String(process.env.V2_DB_NAME || 'QQBotDB');
  const mappings = buildStoreMappings(process.env);

  const client = await getCosmosClient();

  let total = 0;
  const summary = [];

  for (const mapping of mappings) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const count = await migrateContainer(client, dbName, mapping);
      summary.push({ store: mapping.store, container: mapping.container, migrated: count });
      total += count;
      console.log(`migrated ${mapping.store} from ${mapping.container}: ${count}`);
    } catch (err) {
      summary.push({ store: mapping.store, container: mapping.container, migrated: 0, error: err.message });
      console.error(`failed ${mapping.store} from ${mapping.container}: ${err.message}`);
    }
  }

  console.log('migration_summary', JSON.stringify({ total, summary }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
