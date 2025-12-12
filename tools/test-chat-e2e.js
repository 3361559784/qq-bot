const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
    // wait for textarea
    await page.waitForSelector('textarea', { timeout: 5000 });
    const ta = await page.$('textarea');
    if (!ta) throw new Error('textarea not found');

    // Type hello then more text (simulate continuous typing)
    await ta.click();
    await page.keyboard.type('hello');
    await page.keyboard.type(' world');

    // Read value
    const value = await page.$eval('textarea', (el) => (el.value || el.innerText || ''));
    console.log('Textarea value:', JSON.stringify(value));

    if (!value.includes('hello world')) {
      throw new Error('Textarea failed to accept continuous input');
    }

    // Send message by clicking the send button (should appear when input.trim())
    let sendFound = false;
    // Prefer a visible blue send button
    const blueBtn = await page.$('button.bg-blue-600');
    if (blueBtn) {
      await blueBtn.click();
      sendFound = true;
    } else {
      // Fallback: look for any button with an svg child (likely the send icon)
      const btns = await page.$$('button');
      for (const b of btns) {
        const hasSvg = await b.$('svg');
        if (hasSvg) {
          await b.click();
          sendFound = true;
          break;
        }
      }
    }
    if (!sendFound) {
      // press Enter as last resort
      await page.keyboard.press('Enter');
    }

    // Wait for assistant message to appear
    await page.waitForSelector('div:has-text("爱丽丝掉线")', { timeout: 8000 });
    const assistantText = await page.$eval('div:has-text("爱丽丝掉线")', el => el.innerText);
    console.log('Assistant snippet:', assistantText.slice(0, 60));

    console.log('E2E test passed');
  } catch (err) {
    console.error('E2E test failed:', err.message);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();