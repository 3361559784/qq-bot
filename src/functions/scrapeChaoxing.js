/**
 * 学习通课表爬取 HTTP 端点
 * 路由: POST /api/scrapeChaoxing
 * 请求体: { "url": "https://kb.chaoxing.com/...", "userId": "sensei", "cookies": {...} }
 * 
 * ⚠️ 现已切换为远程爬虫服务 (Azure Container Apps)
 */

const { app } = require('@azure/functions');
const { scrapeRemote, cleanScrapedText, isChaoxingUrl } = require('./chaoxingScraperRemote');
const { handleScheduleRequest, cosmosContainer, token } = require('./schoolBot');

/**
 * Azure Function HTTP 触发器
 */
app.http('scrapeChaoxing', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log('[ScrapeChaoxing] 收到请求');

        try {
            // 1. 解析请求体
            const body = await request.json();
            const { url, userId = 'unknown', cookies = null } = body;

            // 2. 参数验证
            if (!url) {
                return {
                    status: 400,
                    jsonBody: { ok: false, error: '缺少必需参数: url' }
                };
            }

            if (!isChaoxingUrl(url)) {
                return {
                    status: 400,
                    jsonBody: { ok: false, error: '仅支持学习通 (chaoxing.com) 域名' }
                };
            }

            context.log(`[ScrapeChaoxing] 用户: ${userId}, URL: ${url}`);
            context.log(`[ScrapeChaoxing] 使用远程爬虫服务`);

            // 3. 执行远程爬取
            const scrapeResult = await scrapeRemote(url, cookies, context);

            if (!scrapeResult.success) {
                return {
                    status: 500,
                    jsonBody: {
                        ok: false,
                        error: '爬取失败',
                        details: scrapeResult.error
                    }
                };
            }

            // 4. 清洗文本数据
            const cleanedText = cleanScrapedText(scrapeResult.text);
            context.log(`[ScrapeChaoxing] 清洗后文本长度: ${cleanedText.length}`);

            // 5. 调用现有的日程解析流程
            const dbKey = `schedule_${userId}`;
            
            const parseResult = await handleScheduleRequest({
                fileLinks: [],        // 没有文件链接
                imageUrls: [],        // 没有图片 URL
                msg: cleanedText,     // 用爬取的文本作为消息体
                senderId: userId,
                dbKey: dbKey,
                cosmosContainer: cosmosContainer,
                context: context,
                token: token
            });

            // 6. 返回结果
            return {
                status: 200,
                jsonBody: {
                    ok: true,
                    scraped: true,
                    url: url,
                    screenshotPath: scrapeResult.screenshotPath,
                    textLength: cleanedText.length,
                    parsed: parseResult.parsed || false,
                    events: parseResult.events || [],
                    summary: parseResult.summary || '未能解析出课程事件',
                    needsConfirmation: parseResult.needsConfirmation || false,
                    rawReply: parseResult.rawReply || ''
                },
                headers: {
                    'Content-Type': 'application/json'
                }
            };

        } catch (error) {
            context.error(`[ScrapeChaoxing] 处理失败: ${error.message}`);
            return {
                status: 500,
                jsonBody: {
                    ok: false,
                    error: '服务器内部错误',
                    details: error.message
                }
            };
        }
    }
});
