const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node tools/playwright-capture-json.js <URL>');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  });

  const page = await context.newPage();
  const captured = [];
  const allResponses = [];

  page.on('response', async response => {
    const url = response.url();
    const status = response.status();
    
    // 记录所有响应用于调试
    allResponses.push({ url, status, contentType: response.headers()['content-type'] });
    
    if (/getAllLessons|getMyLessons|getCurriculum|schedule|apis/.test(url)) {
      console.log(`[捕获] ${url} - ${status}`);
      try {
        const json = await response.json();
        captured.push({ url, status, body: json });
      } catch(e) {
        console.log(`[跳过] ${url} - 非 JSON 响应`);
      }
    }
  });

  console.log(`[Playwright] 正在访问: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  console.log('[Playwright] 等待 5 秒以确保所有 XHR 完成...');
  await page.waitForTimeout(5000);
  
  const outputPath = path.join(process.cwd(), 'captured-json.json');
  fs.writeFileSync(outputPath, JSON.stringify(captured, null, 2));
  
  // 同时保存所有响应用于调试
  const debugPath = path.join(process.cwd(), 'all-responses-debug.json');
  fs.writeFileSync(debugPath, JSON.stringify(allResponses, null, 2));
  
  console.log(`[Playwright] 完成! 捕获 ${captured.length} 个 JSON 响应`);
  console.log(`[Playwright] 总共拦截 ${allResponses.length} 个网络请求`);
  console.log(`[Playwright] 保存到: ${outputPath}`);
  console.log(`[Playwright] 调试文件: ${debugPath}`);

  await browser.close();
})();
