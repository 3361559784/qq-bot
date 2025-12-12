const { hybridSearch } = require('../services/hybridSearch');
const { setCachedSearch } = require('../services/searchCache');

(async () => {
  const query = '本地缓存测试123';
  const fakeResults = [
    { title: '来自本地缓存', snippet: '这是一个基于缓存的测试结果', url: 'https://example.local/test' }
  ];
  const ok = await setCachedSearch(query, fakeResults, 'duckduckgo');
  console.log('setCachedSearch ok:', ok);
  const { success, results, source, formatted, cached } = await hybridSearch(query, { log: console.log }, { maxResults: 3 });
  console.log('hybridSearch result:', { success, source, cached, results: results && results.slice(0,1) });
})();
