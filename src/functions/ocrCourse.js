const { app } = require('@azure/functions');
const {
    handleScheduleRequest,
    cosmosContainer,
    token
} = require('./schoolBot');

// 引入新的 GPT-4o 视觉 OCR 流程
const { ocrScheduleWorkflow } = require('../../services/ocrSchedule');

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
                    jsonBody: { error: 'Missing userId' }
                };
            }

            // 处理图片 OCR (优先使用新的 GPT-4o 视觉流程)
            const imageUrls = Array.isArray(body.imageUrls || body.images) ? (body.imageUrls || body.images) : [];
            
            if (imageUrls.length > 0) {
                context.log(`[ocrCourse] 使用 GPT-4o 视觉处理 ${imageUrls.length} 张图片`);
                
                const ocrToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_MODELS_TOKEN;
                if (!ocrToken) {
                    return {
                        status: 500,
                        jsonBody: { error: 'OCR 需要 GITHUB_TOKEN 环境变量' }
                    };
                }

                try {
                    // 使用新的 GPT-4o 视觉 OCR 流程
                    const { schedule, confidence, text } = await ocrScheduleWorkflow(imageUrls[0], ocrToken);
                    
                    context.log(`[ocrCourse] OCR 成功: ${schedule.length} 门课程, 置信度 ${(confidence * 100).toFixed(1)}%`);
                    
                    // 返回前端期望的格式
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json; charset=utf-8' },
                        jsonBody: {
                            success: true,
                            schedule: schedule,
                            confidence: confidence,
                            ocrText: text,
                            count: schedule.length
                        }
                    };
                } catch (ocrErr) {
                    context.error(`[ocrCourse] GPT-4o OCR 失败: ${ocrErr.message}`);
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json; charset=utf-8' },
                        jsonBody: {
                            success: false,
                            error: `OCR解析失败: ${ocrErr.message}`,
                            schedule: null
                        }
                    };
                }
            }

            // 如果没有图片，回退到原有的 handleScheduleRequest 处理文件等
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
            const dbKey = groupId ? `group_${groupId}` : String(userId);

            const resp = await handleScheduleRequest({
                fileLinks,
                imageUrls: [],
                msg: rawMsg || '',
                senderId: String(userId),
                dbKey,
                cosmosContainer,
                context,
                token
            });

            // handleScheduleRequest 已返回 HTTP 响应结构（或 null）
            if (!resp) {
                return { 
                    status: 200, 
                    jsonBody: { 
                        success: false, 
                        error: '未检测到可解析的课表文件',
                        schedule: null 
                    } 
                };
            }

            // 解析 handleScheduleRequest 返回的内容
            try {
                const bodyContent = typeof resp.body === 'string' ? resp.body : (resp.body && JSON.stringify(resp.body)) || '';
                let maybe = null;
                try {
                    maybe = JSON.parse(bodyContent);
                } catch (e) {
                    // 不是 JSON
                }

                if (maybe && maybe.events && maybe.events.length > 0) {
                    // 转换 events 为 schedule 格式
                    const schedule = maybe.events.map(e => ({
                        courseName: e.title || '未知课程',
                        instructor: null,
                        location: e.location || null,
                        weekday: e.start ? new Date(e.start).getDay() || 7 : null,
                        startTime: e.start ? new Date(e.start).toTimeString().slice(0, 5) : null,
                        endTime: e.end ? new Date(e.end).toTimeString().slice(0, 5) : null,
                        weeks: null
                    }));
                    
                    return {
                        status: 200,
                        jsonBody: {
                            success: true,
                            schedule: schedule,
                            confidence: 0.8,
                            count: schedule.length
                        }
                    };
                }

                return {
                    status: 200,
                    jsonBody: {
                        success: false,
                        error: maybe?.reply || '解析失败',
                        schedule: null
                    }
                };
            } catch (err) {
                context.log(`[ocrCourse] parse response error: ${err.message}`);
                return {
                    status: 200,
                    jsonBody: {
                        success: false,
                        error: '解析响应失败',
                        schedule: null
                    }
                };
            }
        } catch (err) {
            context.error(`[ocrCourse] Error: ${err.message}`);
            return { 
                status: 500, 
                jsonBody: { error: err.message || 'Internal error' } 
            };
        }
    }
});
