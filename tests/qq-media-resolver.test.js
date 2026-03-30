const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeHtmlEntities,
  normalizeMediaValue,
  isHttpUrl,
  resolveQqImageUrl,
  pickFirstResolvedImageUrl
} = require('../src/v2/core/qqMediaResolver');

test('qqMediaResolver: should detect http urls', async () => {
  assert.equal(isHttpUrl('https://example.com/a.jpg'), true);
  assert.equal(isHttpUrl('http://example.com/a.jpg'), true);
  assert.equal(isHttpUrl('abc123.jpg'), false);
});

test('qqMediaResolver: should decode html entities in media urls', async () => {
  const raw = 'https://multimedia.nt.qq.com.cn/download?appid=1406&amp;fileid=abc&amp;rkey=xyz';
  assert.equal(
    decodeHtmlEntities(raw),
    'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=abc&rkey=xyz'
  );
  assert.equal(
    normalizeMediaValue(raw),
    'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=abc&rkey=xyz'
  );
  assert.equal(isHttpUrl(raw), true);
});

test('qqMediaResolver: should return direct url without API lookup', async () => {
  const url = await resolveQqImageUrl({
    type: 'image',
    url: 'https://example.com/img.png',
    file: 'abc123'
  }, null);

  assert.equal(url, 'https://example.com/img.png');
});

test('qqMediaResolver: unresolved file id should return empty when napcat not configured', async () => {
  const bakNapcat = process.env.NAPCAT_API_URL;
  const bakOnebot = process.env.ONEBOT_API_URL;
  process.env.NAPCAT_API_URL = '';
  process.env.ONEBOT_API_URL = '';

  const url = await resolveQqImageUrl({
    type: 'image',
    url: '',
    file: 'abc123def456'
  }, null);

  assert.equal(url, '');

  if (typeof bakNapcat === 'undefined') delete process.env.NAPCAT_API_URL;
  else process.env.NAPCAT_API_URL = bakNapcat;
  if (typeof bakOnebot === 'undefined') delete process.env.ONEBOT_API_URL;
  else process.env.ONEBOT_API_URL = bakOnebot;
});

test('qqMediaResolver: pickFirstResolvedImageUrl should pick metadata image_url first', async () => {
  const req = {
    metadata: {
      image_url: 'https://example.com/from-metadata.jpg'
    },
    attachments: [
      { type: 'image', url: '', file: 'abc123' }
    ]
  };

  const url = await pickFirstResolvedImageUrl(req, null);
  assert.equal(url, 'https://example.com/from-metadata.jpg');
});
