/**
 * DuckDuckGo 搜索服务 - 反限流版本
 * 
 * 特性:
 * - 随机 User-Agent 池
 * - 智能延迟策略 (2-5秒)
 * - 本地缓存 (30分钟过期)
 * - 指数退避重试
 * - IP 安全间隔追踪
 * - 错误回退机制
 */

const https = require('https');
const crypto = require('crypto');

// ==========================================
// 配置参数
// ==========================================

const CONFIG = {
  BASE_URL: 'https://html.duckduckgo.com/html/',
  TIMEOUT: 15000,
  MAX_RETRIES: 3,
  BASE_DELAY: 2000,      // 基础延迟 2 秒
  MAX_DELAY: 5000,       // 最大延迟 5 秒
  CACHE_TTL: 30 * 60 * 1000, // 缓存 30 分钟
  MIN_REQUEST_INTERVAL: 3000, // 最小请求间隔 3 秒
};

// User-Agent 池 (模拟真实浏览器)
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
];

// ==========================================
// 内存缓存
// ==========================================

const searchCache = new Map();
let lastRequestTime = 0;

/**
 * 获取缓存的搜索结果
 */
function getCachedResults(query) {
  const cacheKey = crypto.createHash('md5').update(query.toLowerCase()).digest('hex');
  const cached = searchCache.get(cacheKey);
  
  if (!cached) return null;
  
  const now = Date.now();
  if (now - cached.timestamp > CONFIG.CACHE_TTL) {
    searchCache.delete(cacheKey);
    return null;
  }
  
  return cached.results;
}

/**
 * 缓存搜索结果
 */
function setCachedResults(query, results) {
  const cacheKey = crypto.createHash('md5').update(query.toLowerCase()).digest('hex');
  searchCache.set(cacheKey, {
    results,
    timestamp: Date.now()
  });
  
  // 清理过期缓存 (最多保留 100 条)
  if (searchCache.size > 100) {
    const oldestKeys = Array.from(searchCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, 20)
      .map(([key]) => key);
    
    oldestKeys.forEach(key => searchCache.delete(key));
  }
}

// ==========================================
// 延迟和限流
// ==========================================

/**
 * 智能延迟 (随机 2-5 秒)
 */
async function randomDelay() {
  const delay = CONFIG.BASE_DELAY + Math.random() * (CONFIG.MAX_DELAY - CONFIG.BASE_DELAY);
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * 确保最小请求间隔
 */
async function enforceRateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  
  if (elapsed < CONFIG.MIN_REQUEST_INTERVAL) {
    const waitTime = CONFIG.MIN_REQUEST_INTERVAL - elapsed;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastRequestTime = Date.now();
}

/**
 * 指数退避延迟
 */
async function exponentialBackoff(attempt) {
  const delay = Math.min(
    CONFIG.BASE_DELAY * Math.pow(2, attempt),
    30000 // 最大 30 秒
  );
  await new Promise(resolve => setTimeout(resolve, delay));
}

// ==========================================
// HTTP 请求
// ==========================================

/**
 * 随机选择 User-Agent
 */
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * 发送 HTTP POST 请求到 DuckDuckGo
 */
function httpRequest(query, userAgent) {
  return new Promise((resolve, reject) => {
    const postData = `q=${encodeURIComponent(query)}&kl=cn-zh`;
    
    const options = {
      method: 'POST',
      hostname: 'html.duckduckgo.com',
      path: '/html/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: CONFIG.TIMEOUT
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else if (res.statusCode === 429) {
          reject(new Error('DDG_RATE_LIMIT'));
        } else if (res.statusCode === 403) {
          reject(new Error('DDG_BLOCKED'));
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', (err) => {
      reject(err);
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('TIMEOUT'));
    });
    
    req.write(postData);
    req.end();
  });
}

// ==========================================
// HTML 解析
// ==========================================

/**
 * 解析 DuckDuckGo HTML 响应
 */
function parseResults(html) {
  const results = [];
  
  // 匹配搜索结果块 (简化正则,仅提取标题、URL、描述)
  const resultRegex = /<div class="result__body">[\s\S]*?<a.*?class="result__a".*?href="(.*?)".*?>(.*?)<\/a>[\s\S]*?<a.*?class="result__snippet".*?>(.*?)<\/a>/gi;
  
  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < 10) {
    const url = match[1].replace(/&amp;/g, '&');
    const title = match[2].replace(/<.*?>/g, '').trim();
    const snippet = match[3].replace(/<.*?>/g, '').trim();
    
    if (url && title) {
      results.push({
        title: decodeHTMLEntities(title),
        url: decodeHTMLEntities(url),
        snippet: decodeHTMLEntities(snippet)
      });
    }
  }
  
  return results;
}

/**
 * 解码 HTML 实体
 */
function decodeHTMLEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ==========================================
// 主搜索函数
// ==========================================

/**
 * DuckDuckGo 搜索 (带重试和缓存)
 * 
 * @param {string} query - 搜索关键词
 * @param {number} maxResults - 最大结果数 (默认 5)
 * @returns {Promise<{success: boolean, results: Array, source: string, error?: string}>}
 */
async function duckduckgoSearch(query, maxResults = 5) {
  // 1. 检查缓存
  const cached = getCachedResults(query);
  if (cached) {
    return {
      success: true,
      results: cached.slice(0, maxResults),
      source: 'cache',
      cached: true
    };
  }
  
  // 2. 确保速率限制
  await enforceRateLimit();
  
  // 3. 重试循环
  for (let attempt = 0; attempt < CONFIG.MAX_RETRIES; attempt++) {
    try {
      // 第一次请求前添加随机延迟
      if (attempt > 0) {
        await exponentialBackoff(attempt);
      }
      
      const userAgent = getRandomUserAgent();
      const html = await httpRequest(query, userAgent);
      
      // 检测反爬提示
      if (html.includes('detected an anomaly') || html.includes('unusual traffic')) {
        throw new Error('DDG_ANTI_BOT');
      }
      
      const results = parseResults(html);
      
      if (results.length === 0) {
        throw new Error('NO_RESULTS');
      }
      
      // 缓存结果
      setCachedResults(query, results);
      
      return {
        success: true,
        results: results.slice(0, maxResults),
        source: 'duckduckgo',
        cached: false
      };
      
    } catch (err) {
      const isLastAttempt = attempt === CONFIG.MAX_RETRIES - 1;
      
      // 特殊错误处理
      if (err.message === 'DDG_RATE_LIMIT' || err.message === 'DDG_ANTI_BOT') {
        if (!isLastAttempt) {
          // 被限流,等待更长时间
          await new Promise(resolve => setTimeout(resolve, 10000 * (attempt + 1)));
          continue;
        }
      }
      
      if (err.message === 'DDG_BLOCKED') {
        return {
          success: false,
          results: [],
          source: 'duckduckgo',
          error: 'IP 被 DuckDuckGo 封禁,请稍后重试'
        };
      }
      
      if (isLastAttempt) {
        return {
          success: false,
          results: [],
          source: 'duckduckgo',
          error: `搜索失败: ${err.message}`
        };
      }
    }
  }
  
  return {
    success: false,
    results: [],
    source: 'duckduckgo',
    error: '达到最大重试次数'
  };
}

/**
 * 格式化搜索结果为文本
 */
function formatDDGResults(results, query) {
  if (!results || results.length === 0) {
    return `未找到关于 "${query}" 的相关信息。`;
  }
  
  let formatted = `📚 关于 "${query}" 的搜索结果:\n\n`;
  
  results.forEach((result, index) => {
    formatted += `${index + 1}. 【${result.title}】\n`;
    if (result.snippet) {
      formatted += `   ${result.snippet}\n`;
    }
    formatted += `   🔗 ${result.url}\n\n`;
  });
  
  return formatted.trim();
}

// ==========================================
// 导出
// ==========================================

module.exports = {
  duckduckgoSearch,
  formatDDGResults,
  getCachedResults,
  setCachedResults
};
