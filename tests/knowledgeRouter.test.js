const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planKnowledgeMode,
  formatSearchContext
} = require('../src/v2/core/knowledgeRouter');

test('knowledgeRouter: routes factual query to search_first', () => {
  const mode = planKnowledgeMode('量子纠缠是什么');
  assert.equal(mode.mode, 'search_first');
});

test('knowledgeRouter: formatSearchContext supports output.raw.results shape', () => {
  const text = formatSearchContext({
    status: 'success',
    output: {
      raw: {
        results: [
          {
            title: '量子纠缠 - 维基百科',
            snippet: '量子纠缠是量子力学中的一种非经典关联现象。',
            url: 'https://example.com/qe'
          }
        ]
      }
    }
  });

  assert.match(text, /搜索结果/);
  assert.match(text, /量子纠缠/);
});

test('knowledgeRouter: formatSearchContext falls back to message when no list exists', () => {
  const text = formatSearchContext({
    status: 'success',
    output: {
      message: '没有检索到高置信来源，建议缩小范围。'
    }
  });

  assert.match(text, /搜索结果摘要/);
  assert.match(text, /高置信来源/);
});
