/**
 * 端到端搜索测试
 * 验证整个搜索链路：缓存 → 本地 → DuckDuckGo → 降级
 */

const { hybridSearch, getStats, resetStats } = require('../services/hybridSearch');
const { getCachedSearch } = require('../services/searchCache');

const mockContext = { log: (...args) => console.log('[Test]', ...args) };

async function testE2E() {
  console.log('========================================');
  console.log('🧪 端到端搜索测试');
  console.log('========================================\n');
  
  resetStats();
  
  const testCases = [
    { query: '人工智能', expectSource: 'cache-duckduckgo', desc: '缓存命中测试' },
    { query: 'TypeScript教程', expectSource: 'cache-duckduckgo', desc: '缓存命中测试2' },
    { query: '不存在的查询xyz123', expectSource: null, desc: '未缓存查询（会降级）' }
  ];
  
  for (const { query, expectSource, desc } of testCases) {
    console.log(`\n📝 测试用例: ${desc}`);
    console.log(`   查询: "${query}"`);
    
    try {
      const result = await hybridSearch(query, mockContext, { maxResults: 3 });
      
      console.log(`   ✅ 成功: source=${result.source}, cached=${result.cached || false}`);
      console.log(`   结果数: ${result.results?.length || 0}`);
      
      if (result.results && result.results.length > 0) {
        console.log(`   首条: ${result.results[0].title}`);
      }
      
      if (expectSource && result.source !== expectSource) {
        console.log(`   ⚠️  预期来源 ${expectSource}，实际 ${result.source}`);
      }
    } catch (err) {
      console.log(`   ❌ 失败: ${err.message}`);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log('\n========================================');
  console.log('📊 运行统计');
  console.log('========================================');
  
  const stats = getStats();
  console.log(`总请求: ${stats.totalRequests}`);
  console.log(`缓存命中: ${stats.cacheHits} (${(stats.cacheHits/stats.totalRequests*100).toFixed(1)}%)`);
  console.log(`本地命中: ${stats.localHits} (${(stats.localHits/stats.totalRequests*100).toFixed(1)}%)`);
  console.log(`DDG调用: ${stats.ddgCalls}`);
  console.log(`SerpAPI调用: ${stats.serpCalls}`);
  console.log(`LLM降级: ${stats.llmFallbacks}`);
  
  const freeRate = ((stats.cacheHits + stats.localHits + stats.ddgCalls) / stats.totalRequests * 100).toFixed(1);
  console.log(`\n💰 免费搜索占比: ${freeRate}%`);
  
  console.log('\n========================================');
  console.log('✅ 测试完成');
  console.log('========================================\n');
}

testE2E().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
