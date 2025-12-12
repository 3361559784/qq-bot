const { app } = require('@azure/functions');
const {
    handleScheduleRequest,
    cosmosContainer,
    token
} = require('./schoolBot');

// HTTP API: /api/ocrCourse
// 用于外部直接上传官方导出(ICS/Excel)或截图进行课表解析
app.http('ocrCourse', {
    methods: ['GET', 'POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        // 如果是 GET 请求，返回提示信息
        if (request.method === 'GET') {
            return {
                status: 200,
                body: 'Hello! This is the OCR Course API. Please use POST method with JSON body to upload course data.'
            };
        }

        try {
            const body = await request.json();
            const userId = body.userId || body.senderId || body.uid;
            const groupId = body.groupId || null;
            const rawMsg = body.rawMsg || body.msg || '';

            if (!userId) {
                return {
                    status: 400,
                    body: 'Missing userId'
                };
            }

            // 归一化 fileLinks -> [{url, name}]
            const normalizeLinks = (links) => {
                if (!links) return [];
                if (typeof links === 'string') return [{ url: links }];
                if (Array.isArray(links)) {
                    return links
                        .map((l) => (typeof l === 'string' ? { url: l } : l))
                        .filter((l) => l && l.url);
                }
                if (links.url) return [links];
                return [];
            };

            const fileLinks = normalizeLinks(body.fileLinks || body.files);
            const imageUrls = Array.isArray(body.imageUrls || body.images) ? (body.imageUrls || body.images) : [];

            const dbKey = groupId ? `group_${groupId}` : String(userId);

            const resp = await handleScheduleRequest({
                fileLinks,
                imageUrls,
                msg: rawMsg || '',
                senderId: String(userId),
                dbKey,
                cosmosContainer,
                context,
                token
            });

            // handleScheduleRequest 已返回 HTTP 响应结构（或 null），把它转换为标准化 JSON 输出
            // resp 可能为 null（未识别），或为{status, headers, body}
            let parsedResult = {
                ok: false,
                parsed: false,
                events: [],
                summary: '',
                needsConfirmation: false,
                rawReply: null
            };

            if (!resp) {
                parsedResult.ok = true;
                parsedResult.parsed = false;
                parsedResult.summary = 'No schedule detected';
                return { status: 200, jsonBody: parsedResult };
            }

            // If handleScheduleRequest returns an http-like response with JSON string in body
            try {
                const bodyContent = typeof resp.body === 'string' ? resp.body : (resp.body && JSON.stringify(resp.body)) || '';
                parsedResult.rawReply = bodyContent;
                // 尝试解析 JSON 字符串(若 handleScheduleRequest 返回 JSON.stringify 内容)
                let maybe = null;
                try {
                    maybe = JSON.parse(bodyContent);
                } catch (e) {
                    // 不做处理，使用原始 reply
                }

                if (maybe) {
                    // 由 handleScheduleRequest 返回的结构体，检查常用字段
                    parsedResult.ok = true;
                    // 约定: 如果存在 events 字段则认为解析成功
                    parsedResult.parsed = Boolean(maybe.events && maybe.events.length > 0) || maybe.reply?.includes && !maybe.reply?.includes('未找到');
                    parsedResult.events = maybe.events || [];
                    parsedResult.summary = maybe.summary || (typeof maybe.reply === 'string' ? maybe.reply : '');
                    parsedResult.needsConfirmation = maybe.needsConfirmation || false;
                } else {
                    // 不是 JSON: 尝试从字符串中提取 summary，保底封装
                    parsedResult.ok = true;
                    parsedResult.parsed = resp.status === 200 && !!bodyContent && !bodyContent.includes('无法识别') && !bodyContent.includes('未找到');
                    parsedResult.summary = bodyContent;
                }
            } catch (err) {
                context.log(`[ocrCourse] parse response error: ${err.message}`);
                parsedResult.ok = false;
                parsedResult.summary = 'Error parsing internal response';
            }

            // 明确返回 JSON，避免被序列化为 "[object Object]"
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                jsonBody: parsedResult
            };
        } catch (err) {
            context.error(`[ocrCourse] Error: ${err.message}`);
            return { status: 500, body: err.message || 'Internal error' };
        }
    }
});
