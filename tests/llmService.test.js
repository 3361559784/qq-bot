const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVisionMessages,
  extractResponseText,
  convertImageUrlToDataUrl,
  resolveMaxTokenLimit
} = require('../src/v2/services/llmService');

test('buildVisionMessages emphasizes emotion-aware image understanding', () => {
  const messages = buildVisionMessages({
    imageUrl: 'https://example.com/reaction.png',
    question: '这张图在表达什么情绪？',
    supplementalText: '画面描述: 一个动漫角色低头趴着。'
  });

  assert.equal(Array.isArray(messages), true);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /表情包|动漫图|reaction image/);
  assert.equal(messages[1].role, 'user');
  assert.equal(Array.isArray(messages[1].content), true);
  assert.equal(messages[1].content[1].type, 'image_url');
  assert.equal(messages[1].content[1].image_url.url, 'https://example.com/reaction.png');
  assert.match(messages[1].content[0].text, /表达什么情绪/);
  assert.match(messages[1].content[0].text, /辅助识别结果/);
});

test('extractResponseText supports string and content-part arrays', () => {
  assert.equal(extractResponseText('直接文本'), '直接文本');
  assert.equal(
    extractResponseText([
      { type: 'text', text: '第一句。' },
      { type: 'text', text: '第二句。' }
    ]),
    '第一句。第二句。'
  );
  assert.equal(extractResponseText([{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]), '');
});

test('convertImageUrlToDataUrl keeps data url and non-http values unchanged', async () => {
  const dataUrl = 'data:image/png;base64,AAAA';
  assert.equal(await convertImageUrlToDataUrl(dataUrl), dataUrl);
  assert.equal(await convertImageUrlToDataUrl('local-file-id'), 'local-file-id');
});

test('resolveMaxTokenLimit returns null when no explicit limit is provided', () => {
  assert.equal(resolveMaxTokenLimit({}), null);
  assert.equal(resolveMaxTokenLimit({ max_tokens: undefined }), null);
  assert.equal(resolveMaxTokenLimit({ max_completion_tokens: '' }), null);
});

test('resolveMaxTokenLimit normalizes explicit numeric limits', () => {
  assert.equal(resolveMaxTokenLimit({ max_tokens: 1024 }), 1024);
  assert.equal(resolveMaxTokenLimit({ max_completion_tokens: '2048' }), 2048);
  assert.equal(resolveMaxTokenLimit({ max_tokens: 99.8 }), 99);
});
