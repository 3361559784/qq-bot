/**
 * ChatContext 存储层
 * 负责 ChatContext 的持久化到 Cosmos DB
 */

const { upsertDoc, readDoc, deleteDoc } = require('./storage');

/**
 * 生成 ChatContext 的 partition key
 * @param {string} sessionKey - 会话 key (如 "qq_group:123456")
 * @returns {string}
 */
function chatContextPartition(sessionKey) {
  return `chat_context:${sessionKey}`;
}

/**
 * 从 Cosmos 加载 ChatContext
 * @param {string} sessionKey - 会话 key
 * @param {object} context - Cosmos context
 * @returns {Promise<object|null>}
 */
async function loadChatContext(sessionKey, context = null) {
  if (!sessionKey) return null;
  
  const partitionKey = chatContextPartition(sessionKey);
  
  try {
    const doc = await readDoc('chat_sessions', sessionKey, partitionKey, context);
    if (!doc) return null;
    
    // 验证数据完整性
    if (!doc.session_id || !Array.isArray(doc.transcript)) {
      return null;
    }
    
    return doc;
  } catch (err) {
    // 文档不存在是正常情况
    if (err?.code === 404 || err?.statusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * 保存 ChatContext 到 Cosmos
 * @param {string} sessionKey - 会话 key
 * @param {object} chatContext - ChatContext 对象
 * @param {object} context - Cosmos context
 * @returns {Promise<void>}
 */
async function saveChatContext(sessionKey, chatContext, context = null) {
  if (!sessionKey || !chatContext) {
    throw new Error('sessionKey and chatContext are required');
  }
  
  const partitionKey = chatContextPartition(sessionKey);
  
  // 添加存储元数据
  const doc = {
    ...chatContext,
    id: sessionKey,
    partition_key: partitionKey,
    updated_at: new Date().toISOString(),
    // TTL: 24小时后自动清理（86400秒）
    ttl: 86400
  };
  
  await upsertDoc('chat_sessions', partitionKey, doc, context);
}

/**
 * 删除 ChatContext
 * @param {string} sessionKey - 会话 key
 * @param {object} context - Cosmos context
 * @returns {Promise<void>}
 */
async function deleteChatContext(sessionKey, context = null) {
  if (!sessionKey) return;
  
  const partitionKey = chatContextPartition(sessionKey);
  
  try {
    await deleteDoc('chat_sessions', sessionKey, partitionKey, context);
  } catch (err) {
    // 删除不存在的文档不算错误
    if (err?.code === 404 || err?.statusCode === 404) {
      return;
    }
    throw err;
  }
}

module.exports = {
  loadChatContext,
  saveChatContext,
  deleteChatContext,
  chatContextPartition
};
