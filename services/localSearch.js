/**
 * 本地数据源搜索服务
 * 
 * 数据源:
 * 1. Cosmos DB - 聊天历史、课表数据、用户问答记录
 * 2. 缓存数据 - 常见问题、课程信息
 * 
 * 优势:
 * - 零成本: 不消耗外部 API 配额
 * - 低延迟: 本地数据库查询
 * - 个性化: 基于用户历史数据
 * - 隐私保护: 数据不离开 Azure 环境
 */

let CosmosClient = null;
try {
  ({ CosmosClient } = require('@azure/cosmos'));
} catch {
  CosmosClient = null;
}

// Cosmos DB 连接配置
const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
const cosmosKey = process.env.COSMOS_KEY;
const databaseId = process.env.COSMOS_DATABASE_ID || 'BotDB';
const containerId = process.env.COSMOS_CONTAINER_ID || 'Conversations';

let cosmosContainer = null;

/**
 * 初始化 Cosmos DB 连接
 */
function initCosmosClient() {
  if (!cosmosEndpoint || !cosmosKey) {
    console.warn('[LocalSearch] Cosmos DB 未配置,本地搜索功能禁用');
    return null;
  }

  if (!CosmosClient) {
    console.warn('[LocalSearch] @azure/cosmos 未安装,本地搜索功能禁用');
    return null;
  }

  if (cosmosContainer) {
    return cosmosContainer;
  }

  try {
    const client = new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey });
    cosmosContainer = client.database(databaseId).container(containerId);
    console.log('[LocalSearch] Cosmos DB 连接成功');
    return cosmosContainer;
  } catch (error) {
    console.error('[LocalSearch] Cosmos DB 连接失败:', error.message);
    return null;
  }
}

/**
 * 搜索本地聊天历史
 * @param {string} query - 搜索关键词
 * @param {Object} options - 可选参数
 * @param {number} options.maxResults - 最大结果数 (默认 3)
 * @param {string} options.userId - 用户 QQ 号 (可选,限定用户范围)
 * @returns {Promise<Array>} 搜索结果 { title, snippet, source, relevance, timestamp }
 */
async function searchChatHistory(query, options = {}) {
  const container = initCosmosClient();
  if (!container) {
    return [];
  }

  const { maxResults = 3, userId = null } = options;

  try {
    // 构建查询条件
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);
    if (keywords.length === 0) {
      return [];
    }

    // Cosmos DB SQL 查询 (简化版关键词匹配)
    let sqlQuery = `
      SELECT TOP ${maxResults * 2} c.id, c.qq, c.messages, c._ts
      FROM c
      WHERE ARRAY_LENGTH(c.messages) > 0
    `;

    if (userId) {
      sqlQuery += ` AND c.qq = '${userId}'`;
    }

    sqlQuery += ` ORDER BY c._ts DESC`;

    const { resources: items } = await container.items.query(sqlQuery).fetchAll();

    // 关键词匹配 + 相关度计算
    const results = [];
    for (const item of items) {
      const messages = item.messages || [];
      
      for (const msg of messages) {
        const content = (msg.content || '').toLowerCase();
        const role = msg.role || 'user';
        
        // 计算关键词匹配度
        let matchCount = 0;
        for (const keyword of keywords) {
          if (content.includes(keyword)) {
            matchCount++;
          }
        }

        if (matchCount > 0) {
          const relevance = matchCount / keywords.length;
          
          results.push({
            title: `历史对话 - ${role === 'assistant' ? '机器人回复' : '用户提问'}`,
            snippet: content.substring(0, 150) + (content.length > 150 ? '...' : ''),
            source: 'local_chat_history',
            relevance,
            timestamp: item._ts || Date.now() / 1000,
            userId: item.qq
          });
        }
      }

      if (results.length >= maxResults) {
        break;
      }
    }

    // 按相关度排序
    results.sort((a, b) => b.relevance - a.relevance);

    console.log(`[LocalSearch] 聊天历史搜索: ${query} → ${results.length} 条结果`);
    return results.slice(0, maxResults);

  } catch (error) {
    console.error('[LocalSearch] 聊天历史搜索失败:', error.message);
    return [];
  }
}

/**
 * 搜索课表数据 (基于关键词匹配课程名、教师、地点)
 * @param {string} query - 搜索关键词
 * @param {Object} options - 可选参数
 * @param {number} options.maxResults - 最大结果数 (默认 3)
 * @returns {Promise<Array>} 课程信息结果
 */
async function searchScheduleData(query, options = {}) {
  const container = initCosmosClient();
  if (!container) {
    return [];
  }

  const { maxResults = 3 } = options;

  try {
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);
    if (keywords.length === 0) {
      return [];
    }

    // 查询包含课表数据的记录
    const sqlQuery = `
      SELECT TOP ${maxResults * 2} c.id, c.qq, c.scheduleData, c._ts
      FROM c
      WHERE IS_DEFINED(c.scheduleData)
      ORDER BY c._ts DESC
    `;

    const { resources: items } = await container.items.query(sqlQuery).fetchAll();

    const results = [];
    for (const item of items) {
      const scheduleData = item.scheduleData || {};
      const lessons = scheduleData.lessons || [];

      for (const lesson of lessons) {
        const name = (lesson.name || '').toLowerCase();
        const teacher = (lesson.teacher || '').toLowerCase();
        const location = (lesson.location || '').toLowerCase();

        let matchCount = 0;
        for (const keyword of keywords) {
          if (name.includes(keyword) || teacher.includes(keyword) || location.includes(keyword)) {
            matchCount++;
          }
        }

        if (matchCount > 0) {
          const relevance = matchCount / keywords.length;
          
          results.push({
            title: `课程: ${lesson.name}`,
            snippet: `教师: ${lesson.teacher} | 地点: ${lesson.location} | 时间: ${lesson.start}`,
            source: 'local_schedule',
            relevance,
            timestamp: item._ts || Date.now() / 1000,
            userId: item.qq
          });
        }
      }

      if (results.length >= maxResults) {
        break;
      }
    }

    results.sort((a, b) => b.relevance - a.relevance);

    console.log(`[LocalSearch] 课表搜索: ${query} → ${results.length} 条结果`);
    return results.slice(0, maxResults);

  } catch (error) {
    console.error('[LocalSearch] 课表搜索失败:', error.message);
    return [];
  }
}

/**
 * 统一本地搜索入口
 * @param {string} query - 搜索关键词
 * @param {Object} options - 可选参数
 * @returns {Promise<Array>} 合并的搜索结果
 */
async function localSearch(query, options = {}) {
  const { maxResults = 5, userId = null } = options;

  // 并发搜索多个数据源
  const [chatResults, scheduleResults] = await Promise.all([
    searchChatHistory(query, { maxResults: Math.ceil(maxResults / 2), userId }),
    searchScheduleData(query, { maxResults: Math.ceil(maxResults / 2) })
  ]);

  // 合并结果并按相关度排序
  const allResults = [...chatResults, ...scheduleResults];
  allResults.sort((a, b) => b.relevance - a.relevance);

  console.log(`[LocalSearch] 总计: ${allResults.length} 条本地结果`);
  return allResults.slice(0, maxResults);
}

/**
 * 格式化本地搜索结果
 * @param {Array} results - 本地搜索结果
 * @param {string} query - 查询关键词
 * @returns {string} 格式化文本
 */
function formatLocalResults(results, query) {
  if (!results || results.length === 0) {
    return null; // 返回 null 表示无本地结果,需要外部搜索
  }

  let message = `💾 从本地数据找到关于 "${query}" 的信息:\n\n`;
  
  results.forEach((result, index) => {
    message += `${index + 1}. ${result.title}\n`;
    message += `   ${result.snippet}\n`;
    message += `   📊 相关度: ${(result.relevance * 100).toFixed(0)}% | 来源: ${result.source}\n\n`;
  });

  return message.trim();
}

module.exports = {
  localSearch,
  searchChatHistory,
  searchScheduleData,
  formatLocalResults
};
