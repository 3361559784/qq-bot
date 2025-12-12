/**
 * 混合搜索系统测试脚本 (升级版 - 5层架构)
 * 
 * 测试覆盖:
 * 0. Cosmos 缓存读写
 * 1. Layer 1: 本地数据源搜索 (Cosmos DB)
 * 2. Layer 2: DuckDuckGo 搜索 (免费)
 * 3. Layer 3: SerpAPI 搜索 (Google)
 * 4. Layer 4: LLM 降级回答
 * 5. 统计计数器验证
 * 6. 缓存命中率验证
 */

// 加载环境变量
const fs = require('fs');
const path = require('path');
const settingsPath = path.join(__dirname, '../local.settings.json');
if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  // 仅在 process.env 中不存在时注入配置,避免覆盖系统环境变量
  for (const [k, v] of Object.entries(settings.Values || {})) {
    if (typeof process.env[k] === 'undefined' && typeof v !== 'undefined') {
      process.env[k] = v;
    }
  }
}

const { hybridSearch, getStats, resetStats } = require('../services/hybridSearch');
const { checkSerpApiQuota } = require('../services/serpSearch');
const { duckduckgoSearch } = require('../services/duckduckgoSearch');
const { getCachedSearch, setCachedSearch, getCacheStats } = require('../services/searchCache');

// CLI flags: --skip-ddg, --skip-serp, --skip-llm
const args = process.argv.slice(2);
const SKIP_DDG_FLAG = args.includes('--skip-ddg') || process.env.SKIP_DDG === '1';
const SKIP_SERP_FLAG = args.includes('--skip-serp') || process.env.SKIP_SERP === '1';
const SKIP_LLM_FLAG = args.includes('--skip-llm') || process.env.SKIP_LLM === '1';

// 模拟 Azure Functions context
const mockContext = {
  log: (...args) => console.log('[Context]', ...args)
};

async function testHybridSearch() {
  console.log('========================================');
  console.log('混合搜索系统测试');
  console.log('========================================\n');

  // 重置统计计数器
  resetStats();

  // ==========================================
  // 测试 0: 环境变量检查
  // ==========================================
  console.log('测试 0: 环境变量检查');
  console.log('----------------------------------------');
  
  const requiredEnvVars = ['SERPAPI_KEY', 'GITHUB_TOKEN'];
  const optionalEnvVars = ['COSMOS_ENDPOINT', 'COSMOS_KEY'];
  
  let allRequired = true;
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      console.error(`❌ 缺少必需环境变量: ${envVar}`);
      allRequired = false;
    } else if (process.env[envVar].includes('<your-')) {
      console.error(`❌ ${envVar} 是占位符,请替换为真实值`);
      allRequired = false;
    } else {
      console.log(`✅ ${envVar} 已配置`);
    }
  }
  
  for (const envVar of optionalEnvVars) {
    if (!process.env[envVar]) {
      console.warn(`⚠️  可选环境变量未配置: ${envVar} (本地搜索功能将禁用)`);
    } else {
      console.log(`✅ ${envVar} 已配置`);
    }
  }
  
  if (!allRequired) {
    console.error('\n请先配置所有必需的环境变量');
    process.exit(1);
  }
  
  console.log('\n');

  // ==========================================
  // 测试 1: SerpAPI 配额检查
  // ==========================================
  console.log('测试 1: SerpAPI 配额检查');
  console.log('----------------------------------------');
  if (SKIP_SERP_FLAG) {
    console.log('⚠️ 跳过 SerpAPI 配额检查 (--skip-serp)');
  } else {
    try {
      const quota = await checkSerpApiQuota();
      if (quota.error) {
        console.error(`❌ 配额检查失败: ${quota.error}`);
      } else {
        console.log(`✅ SerpAPI 配额: ${quota.totalSearches} 次剩余`);
        console.log(`   计划: ${quota.plan}`);
        if (quota.expiresAt) {
          console.log(`   过期时间: ${quota.expiresAt}`);
        }
      }
    } catch (err) {
      console.error(`❌ 配额检查异常: ${err.message}`);
    }
  }
  
  console.log('\n');

  // ==========================================
  // 测试 2: Layer 2 (DuckDuckGo) 搜索
  // ==========================================
  console.log('测试 2: Layer 2 - DuckDuckGo 搜索');
  console.log('----------------------------------------');
  if (SKIP_DDG_FLAG) {
    console.log('⚠️ 跳过 DuckDuckGo 搜索测试 (--skip-ddg)');
  } else {
    try {
      const result2 = await duckduckgoSearch('开源软件', 3);
    
      if (result2.success && result2.results.length > 0) {
        console.log(`✅ DDG 搜索成功: ${result2.results.length} 条结果 ${result2.cached ? '(内存缓存)' : '(实时)'}`);
        console.log(`\n预览:\n${result2.results[0].title}\n${result2.results[0].snippet?.substring(0, 100)}...\n`);
      } else {
        console.error(`❌ DDG 搜索失败: ${result2.error || '未知错误'}`);
      }
    } catch (err) {
      console.error(`❌ 测试 2 异常: ${err.message}`);
    }
  }
  
  console.log('\n');

  // ==========================================
  // 测试 3: Layer 3 (SerpAPI) 搜索
  // ==========================================
  console.log('测试 3: Layer 3 - SerpAPI 搜索');
  console.log('----------------------------------------');
  if (SKIP_SERP_FLAG) {
    console.log('⚠️ 跳过 SerpAPI 搜索测试 (--skip-serp)');
  } else {
    try {
      const result3 = await hybridSearch('北京大学', mockContext, {
        skipCache: true,
        skipLocal: true,
        skipDDG: true, // 跳过前两层,直接测试 SerpAPI
        maxResults: 3
      });
    
      if (result3.success && result3.source === 'serp') {
        console.log(`✅ SerpAPI 搜索成功: ${result3.results.length} 条结果`);
        console.log(`\n预览:\n${result3.formatted.substring(0, 200)}...\n`);
      } else {
        console.error(`❌ SerpAPI 搜索失败: ${result3.error || '未知错误'}`);
        console.log(`   实际来源: ${result3.source}`);
      }
    } catch (err) {
      console.error(`❌ 测试 3 异常: ${err.message}`);
    }
  }
  
  console.log('\n');

  // ==========================================
  // 测试 4: Layer 4 (LLM) 降级
  // ==========================================
  console.log('测试 4: Layer 4 - LLM 降级');
  console.log('----------------------------------------');
  if (SKIP_LLM_FLAG) {
    console.log('⚠️ 跳过 LLM 降级测试 (--skip-llm)');
  } else {
    try {
      const result4 = await hybridSearch('asdfghjklqwertyuiop12345', mockContext, {
        skipCache: true,
        skipLocal: true,
        skipDDG: true,
        skipSerp: true, // 跳过前三层,直接测试 LLM
        maxResults: 3
      });
    
      if (result4.source === 'llm') {
        console.log(`✅ LLM 降级成功`);
        console.log(`\n预览:\n${result4.formatted.substring(0, 200)}...\n`);
      } else {
        console.error(`❌ LLM 降级失败: ${result4.error || '未知错误'}`);
        console.log(`   实际来源: ${result4.source}`);
      }
    } catch (err) {
      console.error(`❌ 测试 4 异常: ${err.message}`);
    }
  }
  
  console.log('\n');

  // ==========================================
  // 测试 5: 完整流程 (真实搜索关键词)
  // ==========================================
  console.log('测试 5: 完整混合搜索流程');
  console.log('----------------------------------------');
  
  const testQueries = [
    '人工智能',
    '量子计算',
    'Azure Functions'
  ];
  
  for (const query of testQueries) {
    try {
      console.log(`\n查询: "${query}"`);
      const result = await hybridSearch(query, mockContext, { maxResults: 3 });
      
      if (result.success) {
        console.log(`  ✅ 来源: ${result.source}`);
        console.log(`     结果数: ${result.results.length}`);
      } else {
        console.log(`  ❌ 失败: ${result.error}`);
      }
    } catch (err) {
      console.error(`  ❌ 异常: ${err.message}`);
    }
    
    // 避免触发速率限制
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('\n');

  // ==========================================
  // 测试 6: Cosmos 缓存验证
  // ==========================================
  console.log('测试 6: Cosmos 缓存读写验证');
  console.log('----------------------------------------');
  
  try {
    // 第一次查询 (应该未缓存)
    console.log('\n第一次查询 "区块链技术":');
    const firstResult = await hybridSearch('区块链技术', mockContext, { maxResults: 3 });
    console.log(`  来源: ${firstResult.source}`);
    console.log(`  缓存状态: ${firstResult.cached ? '缓存命中' : '实时查询'}`);
    
    // 等待 2 秒确保写入 Cosmos
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 第二次查询 (应该命中缓存)
    console.log('\n第二次查询 "区块链技术" (应命中缓存):');
    const secondResult = await hybridSearch('区块链技术', mockContext, { maxResults: 3 });
    console.log(`  来源: ${secondResult.source}`);
    console.log(`  缓存状态: ${secondResult.cached ? '✅ 缓存命中' : '⚠️ 未命中缓存'}`);
    
    if (secondResult.cached && secondResult.source.startsWith('cache-')) {
      console.log('✅ Cosmos 缓存工作正常');
    } else {
      console.warn('⚠️ Cosmos 缓存可能未生效');
    }
    
  } catch (err) {
    console.error(`❌ 缓存测试异常: ${err.message}`);
  }
  
  console.log('\n');

  // ==========================================
  // 测试 7: Layer 1 (本地数据) 搜索
  // ==========================================
  console.log('测试 7: Layer 1 - 本地数据搜索');
  console.log('----------------------------------------');
  
  if (!process.env.COSMOS_ENDPOINT || !process.env.COSMOS_KEY) {
    console.warn('⚠️  Cosmos DB 未配置,跳过本地搜索测试');
  } else {
    try {
      const result5 = await hybridSearch('课程', mockContext, {
        userId: '123456789', // 测试用户 ID
        maxResults: 5
      });
      
      if (result5.source === 'local') {
        console.log(`✅ 本地数据命中: ${result5.results.length} 条结果`);
        console.log(`\n预览:\n${result5.formatted.substring(0, 200)}...\n`);
      } else {
        console.log(`⚠️  本地无结果,降级到: ${result5.source}`);
      }
    } catch (err) {
      console.error(`❌ 测试 5 异常: ${err.message}`);
    }
  }
  
  console.log('\n');

  // ==========================================
  // 测试 8: 统计计数器
  // ==========================================
  console.log('测试 8: 统计计数器验证');
  console.log('----------------------------------------');
  
  const stats = getStats();
  console.log('累计统计:');
  console.log(`  总请求数: ${stats.totalRequests}`);
  console.log(`  缓存命中: ${stats.cacheHits} (${(stats.cacheHits / stats.totalRequests * 100).toFixed(1)}%)`);
  console.log(`  本地命中: ${stats.localHits} (${(stats.localHits / stats.totalRequests * 100).toFixed(1)}%)`);
  console.log(`  DDG 调用: ${stats.ddgCalls} (${(stats.ddgCalls / stats.totalRequests * 100).toFixed(1)}%)`);
  console.log(`  SerpAPI 调用: ${stats.serpCalls} (${(stats.serpCalls / stats.totalRequests * 100).toFixed(1)}%)`);
  console.log(`  LLM 降级: ${stats.llmFallbacks} (${(stats.llmFallbacks / stats.totalRequests * 100).toFixed(1)}%)`);
  
  console.log('\n成本分析:');
  const freeRate = ((stats.cacheHits + stats.localHits + stats.ddgCalls) / stats.totalRequests * 100).toFixed(1);
  console.log(`✅ 免费搜索占比: ${freeRate}% (缓存 + 本地 + DDG)`);
  
  if (stats.serpCalls > 100) {
    console.warn(`⚠️  SerpAPI 调用次数 (${stats.serpCalls}) 超过免费额度 (100次/月)`);
  } else {
    console.log(`✅ SerpAPI 使用: ${stats.serpCalls}/100 (${(stats.serpCalls / 100 * 100).toFixed(1)}%)`);
  }
  
  // Cosmos 缓存统计
  try {
    const cacheStats = await getCacheStats();
    console.log(`\nCosmos 缓存统计:`);
    console.log(`  总缓存条目: ${cacheStats.total}`);
    if (cacheStats.bySource) {
      Object.entries(cacheStats.bySource).forEach(([source, count]) => {
        console.log(`  - ${source}: ${count} 条`);
      });
    }
  } catch (err) {
    console.warn(`⚠️ 无法获取 Cosmos 缓存统计: ${err.message}`);
  }
  
  console.log('\n');

  // ==========================================
  // 总结
  // ==========================================
  console.log('========================================');
  console.log('测试总结');
  console.log('========================================');
  
  const testResults = {
    passed: 0,
    failed: 0,
    warnings: 0
  };
  
  // 根据统计推断测试结果
  if (stats.ddgCalls > 0) {
    console.log('✅ DuckDuckGo 搜索可用');
    testResults.passed++;
  } else if (!SKIP_DDG_FLAG) {
    console.warn('⚠️  DuckDuckGo 搜索未测试');
    testResults.warnings++;
  }
  
  if (stats.serpCalls > 0) {
    console.log('✅ SerpAPI 搜索可用');
    testResults.passed++;
  } else if (!SKIP_SERP_FLAG) {
    console.error('❌ SerpAPI 搜索未测试或失败');
    testResults.failed++;
  }
  
  if (stats.llmFallbacks > 0) {
    console.log('✅ LLM 降级可用');
    testResults.passed++;
  } else if (!SKIP_LLM_FLAG) {
    console.warn('⚠️  LLM 降级未测试');
    testResults.warnings++;
  }
  
  if (stats.cacheHits > 0) {
    console.log('✅ Cosmos 缓存可用');
    testResults.passed++;
  } else {
    console.warn('⚠️  Cosmos 缓存未命中 (可能数据库连接问题)');
    testResults.warnings++;
  }
  
  if (stats.localHits > 0) {
    console.log('✅ 本地数据搜索可用');
    testResults.passed++;
  } else {
    console.warn('⚠️  本地数据搜索未命中 (可能数据库为空)');
    testResults.warnings++;
  }
  
  console.log(`\n通过: ${testResults.passed} | 失败: ${testResults.failed} | 警告: ${testResults.warnings}`);
  
  if (testResults.failed > 0) {
    console.error('\n❌ 部分测试失败,请检查配置和日志');
    process.exit(1);
  } else {
    console.log('\n✅ 混合搜索系统测试完成!');
  }
}

testHybridSearch().catch(err => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
