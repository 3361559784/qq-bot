/**
 * 搜索结果缓存服务 (Cosmos DB)
 * 
 * 功能:
 * - 持久化搜索结果到 Cosmos DB
 * - 从缓存读取搜索结果 (避免重复调用外部 API)
 * - 自动过期清理 (7天过期)
 * - 支持多数据源 (DDG, SerpAPI, LLM)
 * 
 * 数据库结构:
 * - 数据库: 机器人人格数据库
 * - 容器: 搜索缓存 (partition key: /query)
 */

let CosmosClient = null;
try {
  ({ CosmosClient } = require('@azure/cosmos'));
} catch {
  CosmosClient = null;
}
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ==========================================
// 配置
// ==========================================

const CONFIG = {
  CACHE_TTL: 7 * 24 * 60 * 60 * 1000, // 7 天过期
  DATABASE_NAME: '机器人人格数据库',
  CONTAINER_NAME: '搜索缓存',
  MAX_CACHE_SIZE: 1000, // 最多保留 1000 条缓存
};

// Cosmos Client (延迟初始化)
let cosmosClient = null;
let database = null;
let container = null;
let useLocalFileCache = false;
let localCacheFilePath = process.env.LOCAL_SEARCH_CACHE_FILE || path.join(__dirname, '..', '.cache', 'search_cache.json');
let localCache = new Map();

function ensureLocalCacheDirExists() {
  const dir = path.dirname(localCacheFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadLocalCacheFromFile() {
  try {
    if (!fs.existsSync(localCacheFilePath)) return;
    const raw = fs.readFileSync(localCacheFilePath, 'utf-8');
    const parsed = JSON.parse(raw || '{}');
    Object.entries(parsed).forEach(([key, value]) => {
      localCache.set(key, value);
    });
  } catch (err) {
    console.error('[SearchCache] 加载本地缓存失败:', err.message);
  }
}

function writeLocalCacheToFile() {
  try {
    ensureLocalCacheDirExists();
    const obj = Object.fromEntries(localCache);
    fs.writeFileSync(localCacheFilePath, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.error('[SearchCache] 写入本地缓存失败:', err.message);
  }
}

/**
 * 初始化 Cosmos DB 连接
 */
async function initCosmosClient() {
  if (container) return container;
  
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  
  if (!endpoint || !key) {
    // Fallback to local file cache when Cosmos DB not configured
    console.warn('[SearchCache] Cosmos DB 未配置，启用本地文件缓存回退', localCacheFilePath);
    useLocalFileCache = true;
    loadLocalCacheFromFile();
    return null;
  }

  if (!CosmosClient) {
    console.warn('[SearchCache] @azure/cosmos 未安装，启用本地文件缓存回退', localCacheFilePath);
    useLocalFileCache = true;
    loadLocalCacheFromFile();
    return null;
  }
  
  cosmosClient = new CosmosClient({ endpoint, key });
  database = cosmosClient.database(CONFIG.DATABASE_NAME);
  
  // 确保容器存在 (如果不存在则创建)
  try {
    const { container: existingContainer } = await database.containers.createIfNotExists({
      id: CONFIG.CONTAINER_NAME,
      partitionKey: { paths: ['/query'] }
    });
    container = existingContainer;
  } catch (err) {
    console.error('[SearchCache] 创建容器失败:', err.message);
    throw err;
  }
  
  return container;
}

// ==========================================
// 缓存读取
// ==========================================

/**
 * 从 Cosmos DB 读取缓存的搜索结果
 * 
 * @param {string} query - 搜索关键词
 * @returns {Promise<{results: Array, source: string, timestamp: number} | null>}
 */
async function getCachedSearch(query) {
  try {
    const container = await initCosmosClient();
    if (useLocalFileCache) {
      const cacheId = crypto.createHash('md5').update(query.toLowerCase()).digest('hex');
      const item = localCache.get(cacheId);
      if (!item) return null;
      const now = Date.now();
      if (now - item.timestamp > CONFIG.CACHE_TTL) {
        localCache.delete(cacheId);
        writeLocalCacheToFile();
        return null;
      }
      return {
        results: item.results,
        source: item.source,
        timestamp: item.timestamp,
        cached: true
      };
    }
    
    // 生成缓存 ID (MD5 hash)
    const cacheId = crypto.createHash('md5').update(query.toLowerCase()).digest('hex');
    
    // 查询缓存
    const { resource: item } = await container.item(cacheId, query).read();
    
    if (!item) {
      return null;
    }
    
    // 检查过期
    const now = Date.now();
    if (now - item.timestamp > CONFIG.CACHE_TTL) {
      // 过期,删除缓存
      await container.item(cacheId, query).delete();
      return null;
    }
    
    return {
      results: item.results,
      source: item.source,
      timestamp: item.timestamp,
      cached: true
    };
    
  } catch (err) {
    if (err.code === 404) {
      // 缓存不存在
      return null;
    }
    
    console.error('[SearchCache] 读取缓存失败:', err.message);
    return null;
  }
}

// ==========================================
// 缓存写入
// ==========================================

/**
 * 将搜索结果写入 Cosmos DB
 * 
 * @param {string} query - 搜索关键词
 * @param {Array} results - 搜索结果数组
 * @param {string} source - 数据源 (duckduckgo, serp, llm)
 * @returns {Promise<boolean>}
 */
async function setCachedSearch(query, results, source) {
  try {
    const container = await initCosmosClient();
    if (useLocalFileCache) {
      const cacheId = crypto.createHash('md5').update(query.toLowerCase()).digest('hex');
      const item = {
        id: cacheId,
        query: query,
        results: results,
        source: source,
        timestamp: Date.now(),
        ttl: Math.floor(CONFIG.CACHE_TTL / 1000)
      };
      localCache.set(cacheId, item);
      // Keep Map size bounded
      if (localCache.size > CONFIG.MAX_CACHE_SIZE) {
        const keysToRemove = Array.from(localCache.keys()).slice(0, localCache.size - CONFIG.MAX_CACHE_SIZE);
        keysToRemove.forEach(k => localCache.delete(k));
      }
      writeLocalCacheToFile();
      return true;
    }
    
    // 生成缓存 ID
    const cacheId = crypto.createHash('md5').update(query.toLowerCase()).digest('hex');
    
    const item = {
      id: cacheId,
      query: query,
      results: results,
      source: source,
      timestamp: Date.now(),
      ttl: Math.floor(CONFIG.CACHE_TTL / 1000) // Cosmos DB TTL (秒)
    };
    
    await container.items.upsert(item);
    
    // 定期清理 (每 100 次写入检查一次)
    if (Math.random() < 0.01) {
      cleanupOldCache().catch(err => {
        console.error('[SearchCache] 清理缓存失败:', err.message);
      });
    }
    
    return true;
    
  } catch (err) {
    console.error('[SearchCache] 写入缓存失败:', err.message);
    return false;
  }
}

// ==========================================
// 缓存清理
// ==========================================

/**
 * 清理过期的缓存 (保留最近 MAX_CACHE_SIZE 条)
 */
async function cleanupOldCache() {
  try {
    const container = await initCosmosClient();
    if (useLocalFileCache) {
      const now = Date.now();
      for (const [key, item] of localCache.entries()) {
        if (now - item.timestamp > CONFIG.CACHE_TTL) {
          localCache.delete(key);
        }
      }
      // Trim to MAX_CACHE_SIZE
      if (localCache.size > CONFIG.MAX_CACHE_SIZE) {
        const entries = Array.from(localCache.entries()).sort((a, b) => b[1].timestamp - a[1].timestamp);
        localCache = new Map(entries.slice(0, CONFIG.MAX_CACHE_SIZE));
      }
      writeLocalCacheToFile();
      return;
    }
    
    // 查询所有缓存,按时间排序
    const querySpec = {
      query: 'SELECT c.id, c.query, c.timestamp FROM c ORDER BY c.timestamp DESC OFFSET @offset ROWS',
      parameters: [
        { name: '@offset', value: CONFIG.MAX_CACHE_SIZE }
      ]
    };
    
    const { resources: oldItems } = await container.items.query(querySpec).fetchAll();
    
    // 删除过期项
    const now = Date.now();
    for (const item of oldItems) {
      if (now - item.timestamp > CONFIG.CACHE_TTL) {
        await container.item(item.id, item.query).delete();
      }
    }
    
  } catch (err) {
    console.error('[SearchCache] 清理失败:', err.message);
  }
}

// ==========================================
// 统计
// ==========================================

/**
 * 获取缓存统计信息
 * 
 * @returns {Promise<{total: number, bySource: Object}>}
 */
async function getCacheStats() {
  try {
    const container = await initCosmosClient();
    if (useLocalFileCache) {
      const bySource = {};
      let total = 0;
      for (const [key, item] of localCache.entries()) {
        bySource[item.source] = (bySource[item.source] || 0) + 1;
        total++;
      }
      return { total, bySource };
    }

    const querySpec = {
      query: 'SELECT c.source, COUNT(1) as count FROM c GROUP BY c.source'
    };

    const { resources: stats } = await container.items.query(querySpec).fetchAll();

    const bySource = {};
    let total = 0;

    stats.forEach(item => {
      bySource[item.source] = item.count;
      total += item.count;
    });

    return { total, bySource };
    
  } catch (err) {
    console.error('[SearchCache] 统计失败:', err.message);
    return { total: 0, bySource: {} };
  }
}

// ==========================================
// 导出
// ==========================================

module.exports = {
  getCachedSearch,
  setCachedSearch,
  cleanupOldCache,
  getCacheStats
};
