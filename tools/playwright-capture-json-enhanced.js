const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node tools/playwright-capture-json-enhanced.js <URL>');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    viewport: { width: 375, height: 667 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    geolocation: { longitude: 114.3054, latitude: 30.5931 }, // 武汉坐标
    permissions: ['geolocation']
  });

  const page = await context.newPage();
  const captured = [];
  const allResponses = [];
  const failedRequests = [];

  // 监听请求失败
  page.on('requestfailed', request => {
    failedRequests.push({
      url: request.url(),
      failure: request.failure()?.errorText
    });
  });

  page.on('response', async response => {
    const url = response.url();
    const status = response.status();
    const contentType = response.headers()['content-type'] || '';
    
    // 记录所有响应
    allResponses.push({ url, status, contentType });
    
    // 捕获所有 JSON API 响应
    if (contentType.includes('application/json') || /getAllLessons|getMyLessons|getCurriculum|apis/.test(url)) {
      console.log(`[捕获] ${url} - ${status}`);
      try {
        const text = await response.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = text.slice(0, 500); // 如果不是 JSON,保存前 500 字符
        }
        captured.push({ url, status, contentType, body });
      } catch(e) {
        console.log(`[错误] ${url} - ${e.message}`);
      }
    }
  });

  // 监听控制台输出
  page.on('console', msg => {
    console.log(`[浏览器控制台] ${msg.type()}: ${msg.text()}`);
  });

  console.log(`[Playwright] 正在访问: ${url}`);
  
  try {
    await page.goto(url, { 
      waitUntil: 'networkidle', 
      timeout: 60000 
    });
    
    console.log('[Playwright] 页面加载完成,等待 JavaScript 执行...');
    await page.waitForTimeout(3000);
    
    // 尝试滚动页面,可能会触发懒加载
    console.log('[Playwright] 滚动页面以触发可能的懒加载...');
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(2000);
    
    // 尝试查找并点击可能的按钮/触发器
    console.log('[Playwright] 检查是否有可点击元素...');
    const clickableElements = await page.$$('button, .btn, [onclick]');
    console.log(`[Playwright] 找到 ${clickableElements.length} 个可点击元素`);
    
    // 再等待一段时间
    console.log('[Playwright] 最终等待 5 秒以确保所有请求完成...');
    await page.waitForTimeout(5000);
    
    // 获取最终 HTML
    const html = await page.content();
    const htmlPath = path.join(process.cwd(), 'captured-page.html');
    fs.writeFileSync(htmlPath, html);
    console.log(`[Playwright] 页面 HTML 已保存: ${htmlPath}`);
    
  } catch (e) {
    console.error(`[Playwright] 导航失败: ${e.message}`);
  }
  
  // 保存结果
  const outputPath = path.join(process.cwd(), 'captured-json-enhanced.json');
  fs.writeFileSync(outputPath, JSON.stringify(captured, null, 2));
  
  const debugPath = path.join(process.cwd(), 'all-responses-enhanced.json');
  fs.writeFileSync(debugPath, JSON.stringify({ 
    allResponses, 
    failedRequests,
    summary: {
      totalResponses: allResponses.length,
      capturedJSON: captured.length,
      failedRequests: failedRequests.length
    }
  }, null, 2));
  
  console.log(`\n=== 摘要 ===`);
  console.log(`捕获 JSON 响应: ${captured.length}`);
  console.log(`总网络请求: ${allResponses.length}`);
  console.log(`失败请求: ${failedRequests.length}`);
  console.log(`\n输出文件:`);
  console.log(`- ${outputPath}`);
  console.log(`- ${debugPath}`);

  await browser.close();
})();
