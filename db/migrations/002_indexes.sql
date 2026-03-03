CREATE INDEX IF NOT EXISTS idx_documents_store_partition_updated
  ON documents (store_name, partition_key, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_documents_store_updated
  ON documents (store_name, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_documents_data_gin
  ON documents USING GIN (data);
