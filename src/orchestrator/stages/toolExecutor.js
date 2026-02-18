/**
 * Stage 7: Tool Executor - 工具执行器
 * 
 * 职责：
 * - 只在 PROCEED && sufficient 情况下运行
 * - 每个 tool call 都要 log toolName, latency, success, evidenceRef
 * 
 * 输出：ToolOutputs
 */

/**
 * 工具注册表
 */
const TOOL_REGISTRY = {
    schedule_query: {
        name: 'schedule_query',
        handler: 'handleScheduleQuery',
        timeout: 5000
    },
    weather_query: {
        name: 'weather_query',
        handler: 'handleWeatherQuery',
        timeout: 10000
    },
    search: {
        name: 'search',
        handler: 'handleSearch',
        timeout: 15000
    },
    schedule_import: {
        name: 'schedule_import',
        handler: 'handleScheduleImport',
        timeout: 30000
    },
    vision: {
        name: 'vision',
        handler: 'handleVision',
        timeout: 20000
    }
};

/**
 * 意图到工具的映射
 */
const INTENT_TO_TOOLS = {
    schedule_query: ['schedule_query'],
    schedule_import: ['schedule_import', 'vision'],
    plan_create: ['schedule_query'],  // 需要先查课表
    weather_query: ['weather_query'],
    search: ['search'],
    vision: ['vision'],
    draw: [],  // 绘图在 LLM 阶段处理
    chat: [],
    identity: [],
    unclear: []
};

function weekdayFromDate(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    const js = d.getDay(); // 0=Sun..6=Sat
    return js === 0 ? 7 : js;
}

function addDays(date, days) {
    const d = date instanceof Date ? new Date(date.getTime()) : new Date(date || Date.now());
    d.setDate(d.getDate() + days);
    return d;
}

function hhmmToMinutes(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    return h * 60 + min;
}

function formatDayLabel(weekday, lang) {
    const zh = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const en = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return (lang === 'en' ? en : zh)[weekday] || String(weekday);
}

function buildScheduleTable(courses, lang) {
    if (!Array.isArray(courses) || courses.length === 0) {
        return lang === 'en' ? 'No classes found.' : '当天没有课程。';
    }

    const header = lang === 'en'
        ? '| Time | Course | Location | Instructor |\\n|---|---|---|---|'
        : '| 时间 | 课程 | 地点 | 老师 |\\n|---|---|---|---|';

    const rows = courses.map((c) => {
        const time = `${c.startTime || ''}-${c.endTime || ''}`.replace(/^-|-$/g, '');
        const name = c.courseName || c.name || '未知课程';
        const loc = c.location || '-';
        const ins = c.instructor || c.teacher || '-';
        return `| ${time || '-'} | ${name} | ${loc} | ${ins} |`;
    });

    return [header, ...rows].join('\\n');
}

function pickCourseNameFromMessage(message, schedule) {
    const text = String(message || '').trim();
    if (!text) return null;
    const names = Array.from(new Set((Array.isArray(schedule) ? schedule : [])
        .map((c) => String(c?.courseName || '').trim())
        .filter(Boolean)));

    let best = null;
    const compactText = text.replace(/\\s+/g, '');
    for (const name of names) {
        if (!name) continue;
        if (text.includes(name)) {
            if (!best || name.length > best.length) best = name;
            continue;
        }
        const compactName = name.replace(/\\s+/g, '');
        if (compactName && compactText.includes(compactName)) {
            if (!best || compactName.length > best.length) best = name;
        }
    }
    return best;
}

function handleScheduleQuery(params, requestContext) {
    const lang = requestContext?.lang || params?.lang || 'zh';
    const schedule = Array.isArray(params?.schedule)
        ? params.schedule
        : (Array.isArray(requestContext?.metadata?.schedule) ? requestContext.metadata.schedule : []);
    const now = requestContext?.timestamp instanceof Date ? requestContext.timestamp : new Date();
    const message = String(params?.message || requestContext?.message || '').trim();

    const wantsNext = /(下一节课|下节课|next\\s+class)/i.test(message);
    const explicitToday = /(今天|today)/i.test(message);
    const explicitTomorrow = /(明天|tomorrow)/i.test(message);
    const explicitDayAfter = /(后天)/.test(message);
    const askedWhen = /(什么时候|几点|何时|when|what\\s+time)/i.test(message);
    const courseName = pickCourseNameFromMessage(message, schedule);

    if (courseName && askedWhen) {
        const matches = schedule.filter((c) => String(c?.courseName || '').includes(courseName));
        matches.sort((a, b) => (a.weekday || 0) - (b.weekday || 0) || String(a.startTime || '').localeCompare(String(b.startTime || '')));
        if (matches.length === 0) {
            return {
                replyText: lang === 'en'
                    ? `No entries found for \"${courseName}\".`
                    : `没有在课表里找到「${courseName}」。`
            };
        }
        const lines = matches.map((c) => {
            const day = formatDayLabel(Number(c.weekday || 0), lang);
            const time = `${c.startTime || ''}-${c.endTime || ''}`.replace(/^-|-$/g, '');
            const loc = c.location ? ` @${c.location}` : '';
            return lang === 'en'
                ? `- ${day} ${time}: ${courseName}${loc}`
                : `- ${day} ${time}：${courseName}${loc}`;
        });
        return {
            replyText: (lang === 'en'
                ? `Here are the schedule entries for \"${courseName}\":\\n\\n`
                : `「${courseName}」上课时间如下：\\n\\n`) + lines.join('\\n')
        };
    }

    let target = weekdayFromDate(now);
    if (explicitTomorrow || params?.date === 'tomorrow') target = weekdayFromDate(addDays(now, 1));
    if (explicitDayAfter || params?.date === 'day_after_tomorrow') target = weekdayFromDate(addDays(now, 2));
    if (explicitToday || params?.date === 'today') target = weekdayFromDate(now);

    const coursesByWeekday = (wd) => schedule
        .filter((c) => Number(c?.weekday) === Number(wd))
        .slice()
        .sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')));

    if (wantsNext) {
        const todayCourses = coursesByWeekday(weekdayFromDate(now));
        const nowMin = now.getHours() * 60 + now.getMinutes();
        let next = todayCourses.find((c) => {
            const startMin = hhmmToMinutes(c.startTime);
            return startMin != null && startMin > nowMin;
        });

        let dayOffset = 0;
        while (!next && dayOffset < 7) {
            dayOffset += 1;
            const wd = weekdayFromDate(addDays(now, dayOffset));
            const arr = coursesByWeekday(wd);
            if (arr.length > 0) {
                next = arr[0];
                break;
            }
        }

        if (!next) {
            return { replyText: lang === 'en' ? 'No upcoming classes found.' : '没有找到接下来一周内的课程。' };
        }
        const day = formatDayLabel(Number(next.weekday || weekdayFromDate(now)), lang);
        const time = `${next.startTime || ''}-${next.endTime || ''}`.replace(/^-|-$/g, '');
        const loc = next.location ? ` @${next.location}` : '';
        return {
            replyText: lang === 'en'
                ? `Next class: ${day} ${time} ${next.courseName || 'Unknown'}${loc}`
                : `下一节课：${day} ${time} ${next.courseName || '未知课程'}${loc}`
        };
    }

    const dayCourses = coursesByWeekday(target);
    const label = (explicitTomorrow || params?.date === 'tomorrow')
        ? (lang === 'en' ? 'Tomorrow' : '明天')
        : (explicitDayAfter || params?.date === 'day_after_tomorrow')
            ? (lang === 'en' ? 'The day after tomorrow' : '后天')
            : (lang === 'en' ? 'Today' : '今天');

    const table = buildScheduleTable(dayCourses, lang);
    return {
        replyText: `${label}（${formatDayLabel(target, lang)}）${lang === 'en' ? ' schedule:' : '课表：'}\\n\\n${table}`
    };
}

/**
 * @typedef {Object} ToolOutput
 * @property {string} name - 工具名称
 * @property {boolean} success - 是否成功
 * @property {number} latencyMs - 延迟
 * @property {any} result - 结果
 * @property {string} evidenceRef - 证据引用
 * @property {string} [error] - 错误信息
 */

/**
 * @typedef {Object} ToolOutputs
 * @property {Array<ToolOutput>} calls - 工具调用列表
 * @property {boolean} success - 整体是否成功
 * @property {Object} aggregatedData - 聚合数据
 */

/**
 * 执行单个工具
 */
async function executeTool(toolName, params, context) {
    const startTime = Date.now();
    const tool = TOOL_REGISTRY[toolName];
    
    if (!tool) {
        return {
            name: toolName,
            success: false,
            latencyMs: Date.now() - startTime,
            result: null,
            evidenceRef: null,
            error: `Unknown tool: ${toolName}`
        };
    }
    
    try {
        if (toolName === 'schedule_query') {
            const schedule = Array.isArray(params?.schedule) ? params.schedule : null;
            if (schedule && schedule.length > 0) {
                const result = handleScheduleQuery(params, params?.requestContext);
                return {
                    name: toolName,
                    success: true,
                    latencyMs: Date.now() - startTime,
                    result,
                    evidenceRef: `tool:${toolName}:${Date.now()}`,
                    error: null
                };
            }
        }

        // TODO: 实际工具调用
        // const handler = require(`../handlers/${tool.handler}`);
        // const result = await handler(params, context);
        
        // 占位实现
        const result = await simulateToolCall(toolName, params, context);
        
        return {
            name: toolName,
            success: true,
            latencyMs: Date.now() - startTime,
            result,
            evidenceRef: `tool:${toolName}:${Date.now()}`,
            error: null
        };
    } catch (error) {
        return {
            name: toolName,
            success: false,
            latencyMs: Date.now() - startTime,
            result: null,
            evidenceRef: null,
            error: error.message
        };
    }
}

/**
 * 模拟工具调用（占位）
 */
async function simulateToolCall(toolName, params, context) {
    context?.log?.(`[ToolExecutor] Simulating tool: ${toolName}`);
    
    // 模拟延迟
    await new Promise(resolve => setTimeout(resolve, 100));
    
    switch (toolName) {
        case 'schedule_query':
            return {
                hasSchedule: false,
                message: '暂无课表数据'
            };
        case 'weather_query':
            return {
                location: params.location || 'Wuhan',
                temperature: 15,
                condition: 'cloudy',
                description: '多云，15°C'
            };
        case 'search':
            return {
                query: params.query,
                results: [],
                message: '搜索功能暂未实现'
            };
        default:
            return { message: 'Tool not implemented' };
    }
}

/**
 * 主入口：工具执行
 * @param {Object} intentResult - 意图路由结果
 * @param {Object} requestContext - 请求上下文
 * @param {Object} availableData - 可用数据
 * @param {Object} context - Azure Functions context
 * @returns {Promise<ToolOutputs>}
 */
async function executeTools(intentResult, requestContext, availableData, context) {
    const { intent, slots } = intentResult;
    
    // 获取需要调用的工具
    const toolsToCall = INTENT_TO_TOOLS[intent] || [];
    
    if (toolsToCall.length === 0) {
        context?.log?.(`[Stage7] No tools needed for intent: ${intent}`);
        return {
            calls: [],
            success: true,
            aggregatedData: {}
        };
    }
    
    const calls = [];
    const aggregatedData = {};
    
    // 串行执行工具（有些工具可能依赖前一个的结果）
    for (const toolName of toolsToCall) {
        const params = {
            ...slots,
            userId: requestContext.userId,
            lang: requestContext.lang,
            message: requestContext.message,
            schedule: requestContext?.metadata?.schedule,
            curriculumUuid: requestContext?.metadata?.curriculumUuid,
            requestContext
        };
        
        const output = await executeTool(toolName, params, context);
        calls.push(output);
        
        if (output.success && output.result) {
            aggregatedData[toolName] = output.result;
        }
        
        context?.log?.(`[Stage7] Tool ${toolName}: success=${output.success} latency=${output.latencyMs}ms`);
    }
    
    // 整体成功：至少有一个工具成功
    const success = calls.some(c => c.success);
    
    return {
        calls,
        success,
        aggregatedData
    };
}

module.exports = {
    executeTools,
    executeTool,
    simulateToolCall,
    TOOL_REGISTRY,
    INTENT_TO_TOOLS
};
