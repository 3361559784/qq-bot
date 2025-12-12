// Playwright network capture script
// Usage: node tools/playwright-network.js <URL>
// Outputs: network-xhr.json, page.html

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node tools/playwright-network.js <URL>');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const requests = [];

  page.on('request', request => {
    const resourceType = request.resourceType();
    const url = request.url();
    requests.push({ id: request._requestId, method: request.method(), url, resourceType, headers: request.headers() });
  });

  page.on('response', async response => {
    try {
      const req = requests.find(r => r.url === response.url());
      const resourceType = response.request().resourceType();
      if (resourceType === 'xhr' || resourceType === 'fetch' || /apis|curriculum|getAllLessons|curriculum\/getMyLessons/.test(response.url())) {
        let body = null;
        try {
          // Limit body size
          const text = await response.text();
          body = text.length > 20000 ? text.slice(0, 20000) + '\n...[truncated]' : text;
        } catch (e) { body = null; }

        const item = {
          url: response.url(),
          status: response.status(),
          ok: response.ok(),
          resourceType: resourceType,
          headers: response.headers(),
          body
        };
        fs.appendFileSync(path.join(process.cwd(), 'network-xhr.json'), JSON.stringify(item, null, 2) + '\n');
      }
    } catch (err) {
      // ignore
    }
  });

  page.on('pageerror', err => console.error('Page error:', err.message));

  console.log('[Playwright] Navigating to', url);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait a little extra for dynamic XHRs
    await page.waitForTimeout(3000);

    const html = await page.content();
    fs.writeFileSync(path.join(process.cwd(), 'page.html'), html);
    console.log('[Playwright] Saved page.html');

    // Save captured XHR list as URLs
    const urls = requests
      .filter(r => r.resourceType === 'xhr' || r.resourceType === 'fetch' || /apis|curriculum|getAllLessons|getMyLessons/.test(r.url))
      .map(r => ({ method: r.method, url: r.url, resourceType: r.resourceType }));

    fs.writeFileSync(path.join(process.cwd(), 'network-requests.json'), JSON.stringify(urls, null, 2));

    console.log('[Playwright] Saved network-requests.json and network-xhr.json (if any XHR responses captured)');

  } catch (err) {
    console.error('[Playwright] Error:', err.message);
  } finally {
    await browser.close();
  }
})();
