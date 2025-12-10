/**
 * 远程爬虫服务调用模块
 * 调用 Azure Container Apps 上的 Playwright 爬虫微服务
 */

/**
 * 调用远程爬虫服务
 * @param {string} url - 学习通课表页面 URL
 * @param {object} cookies - 用户 cookies (可选)
 * @param {object} context - Azure Functions context (用于日志)
 * @returns {Promise<{success: boolean, text: string, schedule: array, screenshot?: string, error?: string}>}
 */
async function scrapeRemote(url, cookies = null, context) {
    const scraperEndpoint = process.env.SCRAPER_ENDPOINT;
    
    if (!scraperEndpoint) {
        throw new Error('环境变量 SCRAPER_ENDPOINT 未设置。请配置 Azure Container Apps 爬虫服务地址');
    }

    context.log(`[RemoteScraper] 调用远程服务: ${scraperEndpoint}`);
    context.log(`[RemoteScraper] 目标 URL: ${url}`);
    
    try {
        const startTime = Date.now();
        
        const response = await fetch(`${scraperEndpoint}/scrape`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Aris-Bot/1.0'
            },
            body: JSON.stringify({ 
                url: url,
                cookies: cookies 
            }),
            timeout: 45000  // 45秒超时
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`远程服务返回错误 ${response.status}: ${errorBody}`);
        }

        const data = await response.json();
        const elapsedTime = Date.now() - startTime;
        
        context.log(`[RemoteScraper] 爬取成功! 耗时: ${elapsedTime}ms`);
        context.log(`[RemoteScraper] 提取课程数: ${data.schedule?.length || 0}`);
        
        return {
            success: data.success,
            text: data.text || '',
            schedule: data.schedule || [],
            week: data.week || '',
            weekDays: data.weekDays || [],
            screenshot: data.screenshot || null,  // Base64 编码的截图
            metadata: data.metadata || {},
            html: '',  // 远程服务不返回 HTML
            screenshotPath: '',  // 远程服务无本地路径
            url: url
        };

    } catch (error) {
        context.error(`[RemoteScraper] 调用失败: ${error.message}`);
        
        return {
            success: false,
            text: '',
            schedule: [],
            week: '',
            weekDays: [],
            screenshot: null,
            html: '',
            screenshotPath: '',
            error: error.message,
            url: url
        };
    }
}

/**
 * 简单的数据清洗 (移除多余空行和特殊字符)
 */
function cleanScrapedText(rawText) {
    return rawText
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[\r\t]/g, ' ')
        .trim();
}

/**
 * 验证 URL 是否是学习通域名
 */
function isChaoxingUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.includes('chaoxing.com');
    } catch {
        return false;
    }
}

module.exports = {
    scrapeRemote,
    cleanScrapedText,
    isChaoxingUrl
};
