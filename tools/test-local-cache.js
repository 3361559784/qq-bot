const { getCachedSearch, setCachedSearch, getCacheStats } = require('../services/searchCache');

(async function test() {
  try {
    console.log('Start local cache test');
    const query = '测试缓存条目';
    const results = [ { title: '示例', snippet: '这是一条示例', url: 'https://example.com' } ];

    const ok = await setCachedSearch(query, results, 'testsource');
    console.log('setCachedSearch result:', ok);

    const cached = await getCachedSearch(query);
    console.log('getCachedSearch result:', cached);

    const stats = await getCacheStats();
    console.log('getCacheStats:', stats);

    console.log('Done');
  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  }
})();
