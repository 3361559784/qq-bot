const axios = require('axios');

/**
 * SerpAPI 搜索服务
 * 
 * 优势:
 * - 免费额度: 每月 100 次调用 (足够个人 QQ 机器人使用)
 * - 稳定可靠: 不会被封禁,官方 API
 * - 结果质量高: 真实 Google 搜索结果
 * - JSON 格式清晰: 易于解析
 * 
 * 注册: https://serpapi.com/users/sign_up
 * 免费计划: 100 searches/month
 */

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

/**
 * 使用 SerpAPI 执行 Google 搜索
 * @param {string} query - 搜索关键词
 * @param {Object} options - 可选参数
 * @param {number} options.count - 返回结果数量 (默认 3)
 * @param {string} options.market - 市场区域 (默认 zh-CN)
 * @param {string} options.safeSearch - 安全搜索 (默认 active)
 * @returns {Promise<Array>} 搜索结果数组 { title, url, snippet }
 */
async function serpSearch(query, options = {}) {
  if (!SERPAPI_KEY) {
    throw new Error('缺少 SERPAPI_KEY 环境变量。请访问 https://serpapi.com 注册账号并获取 API 密钥。');
  }

  const {
    count = 3,
    market = 'zh-CN',
    safeSearch = 'active'
  } = options;

  try {
    console.log(`[SerpAPI] 查询: ${query}`);

    const response = await axios.get(SERPAPI_ENDPOINT, {
      params: {
        q: query,
        api_key: SERPAPI_KEY,
        engine: 'google',
        google_domain: 'google.com',
        gl: market === 'zh-CN' ? 'cn' : 'us',
        hl: market === 'zh-CN' ? 'zh-cn' : 'en',
        safe: safeSearch,
        num: count
      },
      timeout: 10000
    });

    const organicResults = response.data.organic_results || [];
    
    console.log(`[SerpAPI] 找到 ${organicResults.length} 条结果`);

    return organicResults.slice(0, count).map(item => ({
      title: item.title || '未命名',
      url: item.link || item.url || '',
      snippet: item.snippet || item.description || ''
    }));

  } catch (error) {
    console.error('[SerpAPI] 搜索异常:', error.message);
    
    // 详细错误信息
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data?.error;
      
      if (status === 401) {
        throw new Error('SerpAPI 密钥无效或已过期');
      } else if (status === 403) {
        throw new Error('SerpAPI 访问被拒绝');
      } else if (status === 429) {
        throw new Error('SerpAPI 配额已用完 (免费额度: 100次/月)');
      } else if (errorData) {
        throw new Error(`SerpAPI 错误: ${errorData}`);
      }
    }
    
    throw error;
  }
}

/**
 * 格式化 SerpAPI 搜索结果为可读文本
 * @param {Array} results - 搜索结果数组
 * @param {string} query - 原始查询关键词
 * @returns {string} 格式化后的文本
 */
function formatSerpResults(results, query) {
  if (!results || results.length === 0) {
    return `❌ 没找到关于 "${query}" 的相关结果\n建议: 换个说法或关键词试试`;
  }

  let message = `📚 关于 "${query}" 的搜索结果:\n\n`;
  
  results.forEach((result, index) => {
    message += `${index + 1}. 【${result.title}】\n`;
    message += `   ${result.snippet}\n`;
    message += `   🔗 ${result.url}\n\n`;
  });

  return message.trim();
}

/**
 * 检查 SerpAPI 配额使用情况
 * @returns {Promise<Object>} { totalSearches, totalSearchesLeft, plan }
 */
async function checkSerpApiQuota() {
  if (!SERPAPI_KEY) {
    return { error: '缺少 SERPAPI_KEY' };
  }

  try {
    const response = await axios.get('https://serpapi.com/account.json', {
      params: { api_key: SERPAPI_KEY },
      timeout: 5000
    });

    return {
      totalSearches: response.data.total_searches_left || 0,
      plan: response.data.plan || 'free',
      expiresAt: response.data.plan_expires_at || null
    };
  } catch (error) {
    console.error('[SerpAPI] 配额检查失败:', error.message);
    return { error: error.message };
  }
}

module.exports = {
  serpSearch,
  formatSerpResults,
  checkSerpApiQuota
};
