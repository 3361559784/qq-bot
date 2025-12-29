/**
 * 混合搜索服务 - 智能路由策略 (4层架构)
 * 
 * 🛡️ Pillar 3: Reliability (可靠性 - 失败处理，可降级)
 * 
 * 搜索流程 (降级链路):
 * L1: Cosmos 缓存搜索 (永久缓存) - 零成本,秒级响应 [Source: Cache]
 * L2: 本地数据源搜索 (Cosmos DB) - 零成本,低延迟 [Source: Local]
 * L3: DuckDuckGo 搜索 (免费无限) - 反限流机制 [Source: Live-DDG]
 * L4: SerpAPI 搜索 (Google) - 免费 100次/月 [Source: Live-Google]
 * L5: LLM 降级回答 (GPT-4o-mini) - 最终兜底 [Source: AI-Generated] + disclaimer
 * 
 * Pillar 4: Accountability (责任 - 有责任，可解释)
 * - 每次返回都包含 source 标记
 * - 降级时包含 fallback_chain 记录
 * - LLM 生成内容必带 disclaimer
 */

const { localSearch, formatLocalResults } = require('./localSearch');
const { duckduckgoSearch, formatDDGResults } = require('./duckduckgoSearch');
const { serpSearch, formatSerpResults } = require('./serpSearch');
const { getCachedSearch, setCachedSearch } = require('./searchCache');
const { OpenAI } = require('openai');

// 🆕 数据源可信度等级 (Pillar 4: Accountability)
const SourceTrust = Object.freeze({
  VERIFIED: 'verified',           // 可验证数据源（本地数据库）
  LIVE_SEARCH: 'live_search',     // 实时搜索结果
  CACHED: 'cached',               // 缓存数据
  AI_GENERATED: 'ai_generated'    // AI 生成（需免责声明）
});

// 统计计数器 (内存中,重启清零)
const stats = {
  cacheHits: 0,      // 缓存命中次数
  localHits: 0,      // 本地命中次数
  ddgCalls: 0,       // DuckDuckGo 调用次数
  serpCalls: 0,      // SerpAPI 调用次数
  llmFallbacks: 0,   // LLM 降级次数
  totalRequests: 0   // 总请求数
};

/**
 * 用 LLM 基于搜索结果生成完整回答
 * @param {string} query - 用户问题
 * @param {Array} results - 搜索结果数组
 * @param {Object} context - Azure Functions context
 * @returns {Promise<string>} 格式化后的回答
 */
async function summarizeSearchResults(query, results, context) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    context.log('[HybridSearch] 无 GITHUB_TOKEN，跳过 LLM 总结');
    return formatSerpResults(results, query, { showLinks: false });
  }

  try {
    const client = new OpenAI({
      baseURL: "https://models.inference.ai.azure.com",
      apiKey: token
    });

    // 构建搜索结果上下文
    const searchContext = results.map((r, i) => 
      `[${i + 1}] ${r.title}\n${r.snippet}`
    ).join('\n\n');

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 4096,
      messages: [{
        role: 'system',
        content: `你是一个知识助手。根据搜索结果，用清晰、完整、详细的中文回答用户问题。
要求：
1. 综合多个搜索结果的信息，给出完整详细的回答
2. 不要只是罗列搜索结果，而是整合成结构化的回答
3. 如果搜索结果信息不足，可以补充你的知识
4. 回答要专业但易懂，适合普通用户阅读
5. 不要省略重要信息，可以使用编号列表呈现要点
6. 不要提及"搜索结果"、"根据资料"等词，直接回答`
      }, {
        role: 'user',
        content: `问题：${query}\n\n搜索结果：\n${searchContext}`
      }]
    });

    const answer = resp.choices[0]?.message?.content;
    
    if (answer) {
      context.log('[HybridSearch] ✅ LLM 总结成功');
      return `📚 ${answer}`;
    }
  } catch (error) {
    context.log(`[HybridSearch] LLM 总结失败: ${error.message}`);
  }

  // 降级：返回原始格式化结果
  return formatSerpResults(results, query, { showLinks: false });
}

/**
 * 混合搜索 - 智能路由 (4层架构)
 * @param {string} query - 搜索关键词
 * @param {Object} context - Azure Functions context (日志输出)
 * @param {Object} options - 可选参数
 * @param {string} options.userId - 用户 QQ 号 (用于本地搜索个性化)
 * @param {number} options.maxResults - 最大结果数 (默认 5)
 * @param {boolean} options.skipCache - 跳过缓存 (默认 false)
 * @param {boolean} options.skipLocal - 跳过本地搜索 (默认 false)
 * @param {boolean} options.skipDDG - 跳过 DuckDuckGo (默认 true，不稳定)
 * @param {boolean} options.skipSerp - 跳过 SerpAPI (默认 false)
 * @param {boolean} options.summarize - 是否用 LLM 总结搜索结果 (默认 true)
 * @returns {Promise<Object>} { success, results, source, formatted, error }
 */
async function hybridSearch(query, context, options = {}) {
  const {
    userId = null,
    maxResults = 5,
    skipCache = false,
    skipLocal = false,
    skipDDG = true,  // 默认跳过 DuckDuckGo（不稳定，经常被限流）
    skipSerp = false,
    summarize = true  // 默认用 LLM 总结搜索结果
  } = options;

  stats.totalRequests++;
  
  // 🆕 Pillar 3 & 4: 追踪降级链路
  const fallbackChain = [];
  const startTime = Date.now();

  // ==========================================
  // Layer 0: Cosmos 缓存搜索 (最高优先级)
  // ==========================================
  if (!skipCache) {
    try {
      context.log(`[HybridSearch] Layer 0: 缓存查询 - ${query}`);
      fallbackChain.push({ layer: 'L0_cache', status: 'attempting' });
      
      const cached = await getCachedSearch(query);
      
      if (cached && cached.results.length > 0) {
        stats.cacheHits++;
        fallbackChain[fallbackChain.length - 1].status = 'hit';
        
        const formatted = formatCachedResults(cached.results, query, cached.source);
        
        context.log(`[HybridSearch] ✅ 缓存命中: ${cached.results.length} 条结果 (来源: ${cached.source})`);
        context.log(`[Stats] 缓存命中率: ${(stats.cacheHits / stats.totalRequests * 100).toFixed(1)}%`);
        
        return {
          success: true,
          results: cached.results.slice(0, maxResults),
          source: `cache-${cached.source}`,
          sourceLabel: '[Source: Cache]',
          trustLevel: SourceTrust.CACHED,
          formatted,
          cached: true,
          latencyMs: Date.now() - startTime,
          fallbackChain,
          stats: { ...stats }
        };
      }
      
      fallbackChain[fallbackChain.length - 1].status = 'miss';
      context.log('[HybridSearch] 缓存未命中,进入 Layer 1');
      
    } catch (error) {
      fallbackChain[fallbackChain.length - 1].status = 'error';
      fallbackChain[fallbackChain.length - 1].error = error.message;
      context.log(`[HybridSearch] 缓存查询异常: ${error.message}`);
    }
  }

  // ==========================================
  // Layer 1: 本地数据源搜索 (用户数据)
  // ==========================================
  if (!skipLocal) {
    try {
      context.log(`[HybridSearch] Layer 1: 本地搜索 - ${query}`);
      fallbackChain.push({ layer: 'L1_local', status: 'attempting' });
      
      const localResults = await localSearch(query, { maxResults, userId });
      
      if (localResults && localResults.length > 0) {
        stats.localHits++;
        fallbackChain[fallbackChain.length - 1].status = 'hit';
        
        const formatted = formatLocalResults(localResults, query);
        
        context.log(`[HybridSearch] ✅ 本地命中: ${localResults.length} 条结果`);
        context.log(`[Stats] 本地命中率: ${(stats.localHits / stats.totalRequests * 100).toFixed(1)}%`);
        
        // 写入缓存
        setCachedSearch(query, localResults, 'local').catch(err => {
          context.log(`[HybridSearch] 缓存写入失败: ${err.message}`);
        });
        
        return {
          success: true,
          results: localResults,
          source: 'local',
          sourceLabel: '[Source: Local Database]',
          trustLevel: SourceTrust.VERIFIED,
          formatted,
          latencyMs: Date.now() - startTime,
          fallbackChain,
          stats: { ...stats }
        };
      }
      
      fallbackChain[fallbackChain.length - 1].status = 'miss';
      context.log('[HybridSearch] 本地无结果,进入 Layer 2');
      
    } catch (error) {
      fallbackChain[fallbackChain.length - 1].status = 'error';
      fallbackChain[fallbackChain.length - 1].error = error.message;
      context.log(`[HybridSearch] 本地搜索异常: ${error.message}`);
    }
  }

  // ==========================================
  // Layer 2: DuckDuckGo 搜索 (免费无限)
  // ==========================================
  if (!skipDDG) {
    try {
      context.log(`[HybridSearch] Layer 2: DuckDuckGo 搜索 - ${query}`);
      fallbackChain.push({ layer: 'L2_ddg', status: 'attempting' });
      
      const ddgResult = await duckduckgoSearch(query, maxResults);
      
      if (ddgResult.success && ddgResult.results.length > 0) {
        stats.ddgCalls++;
        fallbackChain[fallbackChain.length - 1].status = 'hit';
        
        const formatted = formatDDGResults(ddgResult.results, query);
        
        context.log(`[HybridSearch] ✅ DDG 命中: ${ddgResult.results.length} 条结果 (${ddgResult.cached ? '内存缓存' : '实时'})`);
        context.log(`[Stats] DDG 调用: ${stats.ddgCalls} 次`);
        
        // 写入 Cosmos 缓存
        setCachedSearch(query, ddgResult.results, 'duckduckgo').catch(err => {
          context.log(`[HybridSearch] 缓存写入失败: ${err.message}`);
        });
        
        return {
          success: true,
          results: ddgResult.results,
          source: 'duckduckgo',
          sourceLabel: '[Source: Live-DDG]',
          trustLevel: SourceTrust.LIVE_SEARCH,
          formatted,
          latencyMs: Date.now() - startTime,
          fallbackChain,
          stats: { ...stats }
        };
      }
      
      fallbackChain[fallbackChain.length - 1].status = 'miss';
      context.log('[HybridSearch] DDG 无结果或失败,进入 Layer 3');
      
    } catch (error) {
      fallbackChain[fallbackChain.length - 1].status = 'error';
      fallbackChain[fallbackChain.length - 1].error = error.message;
      context.log(`[HybridSearch] DDG 异常: ${error.message}`);
    }
  }

  // ==========================================
  // Layer 3: SerpAPI 外部搜索 (付费备份)
  // ==========================================
  if (!skipSerp) {
    try {
      context.log(`[HybridSearch] Layer 3: SerpAPI 搜索 - ${query}`);
      fallbackChain.push({ layer: 'L3_serp', status: 'attempting' });
      
      const serpResults = await serpSearch(query, { count: maxResults });
      
      if (serpResults && serpResults.length > 0) {
        stats.serpCalls++;
        fallbackChain[fallbackChain.length - 1].status = 'hit';
        
        context.log(`[HybridSearch] ✅ SerpAPI 命中: ${serpResults.length} 条结果`);
        context.log(`[Stats] SerpAPI 调用: ${stats.serpCalls} 次`);
        
        // 如果启用 summarize，用 LLM 基于搜索结果生成完整回答
        let formatted;
        if (summarize) {
          formatted = await summarizeSearchResults(query, serpResults, context);
        } else {
          formatted = formatSerpResults(serpResults, query, { showLinks: false });
        }
        
        // 写入缓存（存原始结果，不存总结）
        setCachedSearch(query, serpResults, 'serp').catch(err => {
          context.log(`[HybridSearch] 缓存写入失败: ${err.message}`);
        });
        
        return {
          success: true,
          results: serpResults,
          source: 'serp',
          sourceLabel: '[Source: Live-Google]',
          trustLevel: SourceTrust.LIVE_SEARCH,
          formatted,
          latencyMs: Date.now() - startTime,
          fallbackChain,
          stats: { ...stats }
        };
      }
      
      fallbackChain[fallbackChain.length - 1].status = 'miss';
      context.log('[HybridSearch] SerpAPI 无结果,进入 Layer 4');
      
    } catch (error) {
      fallbackChain[fallbackChain.length - 1].status = 'error';
      fallbackChain[fallbackChain.length - 1].error = error.message;
      context.log(`[HybridSearch] SerpAPI 异常: ${error.message}`);
      
      // 特殊处理配额耗尽
      if (error.message.includes('配额已用完')) {
        context.log('[HybridSearch] ⚠️ SerpAPI 配额耗尽,跳过外部搜索');
      }
    }
  }

  // ==========================================
  // Layer 4: LLM 降级回答 (最终兜底)
  // ==========================================
  try {
    context.log(`[HybridSearch] Layer 4: LLM 降级回答 - ${query}`);
    fallbackChain.push({ layer: 'L4_llm', status: 'attempting' });
    
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('缺少 GITHUB_TOKEN,无法使用 LLM 降级');
    }

    const client = new OpenAI({
      baseURL: "https://models.inference.ai.azure.com",
      apiKey: token
    });

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `请用简洁中文回答: ${query}\n\n注意: 这是在没有搜索结果的情况下的直接回答,请保持客观和准确。`
      }]
    });

    const answer = resp.choices[0]?.message?.content || '抱歉,无法生成回答';
    
    stats.llmFallbacks++;
    fallbackChain[fallbackChain.length - 1].status = 'hit';
    
    context.log(`[HybridSearch] ✅ LLM 降级成功`);
    context.log(`[Stats] LLM 降级: ${stats.llmFallbacks} 次`);
    
    const llmResult = [{ title: 'AI 生成回答', snippet: answer, url: '', source: 'llm' }];
    
    // 缓存 LLM 回答
    setCachedSearch(query, llmResult, 'llm').catch(err => {
      context.log(`[HybridSearch] 缓存写入失败: ${err.message}`);
    });
    
    return {
      success: true,
      results: llmResult,
      source: 'llm',
      sourceLabel: '[Source: AI-Generated]',
      trustLevel: SourceTrust.AI_GENERATED,
      disclaimer: true,  // 🆕 Pillar 4: 标记需要免责声明
      formatted: `🤖 AI 回答:\n\n${answer}\n\n⚠️ 此回答由 AI 生成,未经搜索验证`,
      latencyMs: Date.now() - startTime,
      fallbackChain,
      stats: { ...stats }
    };

  } catch (error) {
    fallbackChain[fallbackChain.length - 1].status = 'error';
    fallbackChain[fallbackChain.length - 1].error = error.message;
    context.log(`[HybridSearch] LLM 降级失败: ${error.message}`);
    
    stats.llmFallbacks++; // 失败也计数
    
    return {
      success: false,
      error: '搜索服务暂时不可用,请稍后再试',
      source: 'none',
      sourceLabel: '[Source: None]',
      trustLevel: null,
      formatted: '❌ 搜索服务暂时不可用\n\n所有搜索层均失败:\n- 缓存: 无匹配结果\n- 本地数据: 无匹配结果\n- DuckDuckGo: 调用失败或被限流\n- SerpAPI: 调用失败或配额耗尽\n- LLM 降级: 生成失败',
      latencyMs: Date.now() - startTime,
      fallbackChain,
      stats: { ...stats }
    };
  }
}

/**
 * 格式化缓存结果
 */
function formatCachedResults(results, query, source) {
  const sourceLabel = {
    'local': '本地数据',
    'duckduckgo': 'DuckDuckGo',
    'serp': 'Google',
    'llm': 'AI 生成'
  }[source] || source;
  
  if (source === 'llm') {
    return `🤖 AI 回答 (缓存):\n\n${results[0].snippet}\n\n⚠️ 此回答由 AI 生成,未经搜索验证`;
  }
  
  let formatted = `📚 关于 "${query}" 的搜索结果:\n\n`;
  
  results.forEach((result, index) => {
    formatted += `${index + 1}. 【${result.title}】\n`;
    if (result.snippet) {
      formatted += `   ${result.snippet}\n`;
    }
    // 不再显示链接
    formatted += '\n';
  });
  
  return formatted.trim();
}

/**
 * 重置统计计数器 (用于测试或周期性重置)
 */
function resetStats() {
  stats.cacheHits = 0;
  stats.localHits = 0;
  stats.ddgCalls = 0;
  stats.serpCalls = 0;
  stats.llmFallbacks = 0;
  stats.totalRequests = 0;
  console.log('[HybridSearch] 统计计数器已重置');
}

/**
 * 获取当前统计数据
 * @returns {Object} 统计计数器副本
 */
function getStats() {
  return { ...stats };
}

module.exports = {
  hybridSearch,
  resetStats,
  getStats,
  SourceTrust  // 🆕 导出可信度等级枚举
};
