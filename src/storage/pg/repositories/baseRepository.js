const { query } = require('../client');

function docRowToObject(row) {
  if (!row) return null;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  if (!data.partitionKey) data.partitionKey = row.partition_key;
  return data;
}

async function upsert(storeName, partitionKey, doc) {
  const id = String(doc?.id || '').trim();
  if (!id) throw new Error('doc_id_required');

  const payload = {
    ...doc,
    partitionKey
  };

  const sql = `
    INSERT INTO documents (store_name, partition_key, id, data)
    VALUES ($1, $2, $3, $4::jsonb)
    ON CONFLICT (store_name, partition_key, id)
    DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    RETURNING *
  `;

  const res = await query(sql, [storeName, partitionKey, id, JSON.stringify(payload)]);
  return docRowToObject(res.rows[0]);
}

async function getById(storeName, partitionKey, id) {
  const sql = `
    SELECT *
    FROM documents
    WHERE store_name = $1 AND partition_key = $2 AND id = $3
    LIMIT 1
  `;
  const res = await query(sql, [storeName, partitionKey, id]);
  return docRowToObject(res.rows[0]);
}

async function listByPartition(storeName, partitionKey, limit = 100) {
  const sql = `
    SELECT *
    FROM documents
    WHERE store_name = $1 AND partition_key = $2
    ORDER BY updated_at DESC
    LIMIT $3
  `;
  const res = await query(sql, [storeName, partitionKey, Number(limit)]);
  return res.rows.map(docRowToObject);
}

async function listStore(storeName, limit = 100, offset = 0) {
  const sql = `
    SELECT *
    FROM documents
    WHERE store_name = $1
    ORDER BY updated_at DESC
    LIMIT $2 OFFSET $3
  `;
  const res = await query(sql, [storeName, Number(limit), Number(offset)]);
  return res.rows.map(docRowToObject);
}

async function remove(storeName, partitionKey, id) {
  const sql = `
    DELETE FROM documents
    WHERE store_name = $1 AND partition_key = $2 AND id = $3
    RETURNING id
  `;
  const res = await query(sql, [storeName, partitionKey, id]);
  return res.rowCount > 0;
}

module.exports = {
  upsert,
  getById,
  listByPartition,
  listStore,
  remove
};
