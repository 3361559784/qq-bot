/**
 * Stage 5: Intent Router - 意图路由器
 * 
 * 职责：
 * - 规则 + LLM 做 intent 判定
 * - 输出 clarification_needed + missing_slots（如果模糊）
 * 
 * 输出：IntentResult
 */

/**
 * 意图类型
 */
const INTENT_TYPES = {
    SCHEDULE_QUERY: 'schedule_query',       // 查询课表
    SCHEDULE_IMPORT: 'schedule_import',     // 导入课表
    PLAN_CREATE: 'plan_create',             // 创建计划
    PLAN_QUERY: 'plan_query',               // 查询计划
    WEATHER_QUERY: 'weather_query',         // 查询天气
    SEARCH: 'search',                       // 搜索信息
    IDENTITY: 'identity',                   // 身份询问
    CHAT: 'chat',                           // 闲聊
    VISION: 'vision',                       // 图像识别
    DRAW: 'draw',                           // 绘图
    UNCLEAR: 'unclear'                      // 不明确
};

/**
 * 规则路由配置
 * 优先使用规则，降低 LLM 调用
 */
const RULE_BASED_INTENTS = {
    schedule_query: {
        patterns: {
            zh: [
                /(查|看|有什么).*(课|课表|课程)/,
                /(今天|明天|后天|周[一二三四五六日天]).*(课|有什么)/,
                /(几点|什么时候).*(上课|下课)/,
                /(什么时候上|何时上|下一节课|下节课)/,
                /(空闲|空档|没课|有课)/,
                /课表/
            ],
            en: [
                /(check|show|what).*(class|schedule|course)/i,
                /(today|tomorrow).*(class|have)/i,
                /(when|what time).*(class|lecture)/i,
                /(next\s+class)/i,
                /(free|available|no class)/i
            ]
        },
        confidence: 0.85,
        requiredSlots: [],
        optionalSlots: ['date', 'dayOfWeek', 'timeRange']
    },
    schedule_import: {
        patterns: {
            zh: [
                /(导入|上传|添加|更新).*(课表|课程)/,
                /这是我的课表/,
                /(解析|识别).*(课表|图片)/
            ],
            en: [
                /(import|upload|add|update).*(schedule|timetable)/i,
                /this is my (schedule|timetable)/i
            ]
        },
        confidence: 0.90,
        requiredSlots: [],
        optionalSlots: []
    },
    plan_create: {
        patterns: {
            zh: [
                /(帮我|给我).*(规划|安排|计划|制定)/,
                /(怎么|如何).*(安排|规划).*(时间|学习)/,
                /(制定|做).*(计划|规划)/,
                /(复习|学习).*(计划|安排)/
            ],
            en: [
                /(help me|make).*(plan|schedule|arrange)/i,
                /how (to|should i) (plan|arrange|schedule)/i,
                /(create|make) (a )?(study )?plan/i
            ]
        },
        confidence: 0.80,
        requiredSlots: ['target'],
        optionalSlots: ['dateRange', 'duration', 'constraints']
    },
    weather_query: {
        patterns: {
            zh: [
                /(天气|气温|温度)/,
                /(下雨|下雪|晴|阴|多云)/,
                /(会不会|需要).*雨/,
                /(穿|带).*(什么|衣服|伞)/
            ],
            en: [
                /(weather|temperature)/i,
                /(rain|snow|sunny|cloudy)/i,
                /(will it|is it going to) rain/i,
                /(what to wear|need.*umbrella)/i
            ]
        },
        confidence: 0.85,
        requiredSlots: [],  // location 可以有默认值
        optionalSlots: ['location', 'date']
    },
    search: {
        patterns: {
            zh: [
                /(搜索|搜一下|查一下|查询|找一下)/,
                /(是什么|什么是|怎么回事)/,
                /(百度|谷歌|搜)/
            ],
            en: [
                /(search|look up|find|google)/i,
                /(what is|what are|what does)/i
            ]
        },
        confidence: 0.75,
        requiredSlots: ['query'],
        optionalSlots: ['scope']
    },
    draw: {
        patterns: {
            zh: [
                /(画|绘|生成).*(图|画|图片|插画)/,
                /(画一个|画一张|来一张)/,
                /帮我画/
            ],
            en: [
                /(draw|generate|create).*(image|picture|illustration)/i,
                /draw (me )?(a |an )?/i
            ]
        },
        confidence: 0.85,
        requiredSlots: [],
        optionalSlots: ['subject', 'style']
    },
    vision: {
        patterns: {
            zh: [
                /(识别|看|分析).*(图|图片|照片)/,
                /这是什么/,
                /(图片|照片)里.*(是|有)/
            ],
            en: [
                /(identify|analyze|look at).*(image|picture|photo)/i,
                /what('s| is) (this|in this)/i
            ]
        },
        confidence: 0.80,
        requiredSlots: [],
        optionalSlots: []
    }
};

/**
 * @typedef {Object} IntentResult
 * @property {string} intent - 意图类型
 * @property {number} confidence - 置信度
 * @property {boolean} clarificationNeeded - 是否需要澄清
 * @property {Array<string>} missingSlots - 缺失的必要槽位
 * @property {Object} slots - 提取的槽位
 * @property {string} routeMethod - 路由方法 (rule|llm)
 * @property {Object} llmResponse - LLM 响应（如果使用）
 */

/**
 * 规则匹配意图
 */
function matchIntentByRule(msg, lang) {
    for (const [intent, config] of Object.entries(RULE_BASED_INTENTS)) {
        const patterns = config.patterns[lang] || config.patterns['zh'];
        for (const pattern of patterns) {
            if (pattern.test(msg)) {
                return {
                    intent,
                    confidence: config.confidence,
                    requiredSlots: config.requiredSlots,
                    optionalSlots: config.optionalSlots,
                    routeMethod: 'rule'
                };
            }
        }
    }
    return null;
}

/**
 * LLM 意图路由（fallback）
 */
async function routeIntentWithLLM(msg, semanticFrame, history, context) {
    // TODO: 实际 LLM 调用
    // 这里返回一个占位结果
    context?.log?.('[IntentRouter] LLM routing not implemented yet, returning unclear');
    
    return {
        intent: INTENT_TYPES.CHAT,
        confidence: 0.5,
        requiredSlots: [],
        optionalSlots: [],
        routeMethod: 'llm',
        llmResponse: null
    };
}

/**
 * 检查是否需要澄清
 */
function checkClarificationNeeded(intentResult, semanticFrame, slots) {
    // 置信度太低
    if (intentResult.confidence < 0.6) {
        return {
            needed: true,
            reason: 'low_confidence',
            missingSlots: []
        };
    }
    
    // 缺少必要槽位
    const missingRequired = [];
    for (const required of intentResult.requiredSlots || []) {
        if (!slots[required] && !semanticFrame.slots?.[required]) {
            missingRequired.push(required);
        }
    }
    
    if (missingRequired.length > 0) {
        return {
            needed: true,
            reason: 'missing_slots',
            missingSlots: missingRequired
        };
    }
    
    // 意图不明确
    if (intentResult.intent === INTENT_TYPES.UNCLEAR) {
        return {
            needed: true,
            reason: 'unclear_intent',
            missingSlots: []
        };
    }
    
    return { needed: false, reason: null, missingSlots: [] };
}

/**
 * 合并槽位
 */
function mergeSlots(semanticSlots, extractedSlots) {
    return { ...semanticSlots, ...extractedSlots };
}

/**
 * 主入口：意图路由
 * @param {Object} requestContext - 标准化后的请求上下文
 * @param {Object} semanticFrame - 语义帧
 * @param {Array} sanitizedHistory - 清洗后的历史
 * @param {Object} context - Azure Functions context
 * @returns {Promise<IntentResult>}
 */
async function routeIntent(requestContext, semanticFrame, sanitizedHistory, context) {
    const { message, lang, metadata } = requestContext;
    
    // 特殊处理：有图片 → 可能是 vision 或 schedule_import
    if (metadata?.hasImage) {
        // 如果同时有课表相关关键词，优先 schedule_import
        if (/课表|schedule|timetable/i.test(message)) {
            return {
                intent: INTENT_TYPES.SCHEDULE_IMPORT,
                confidence: 0.90,
                clarificationNeeded: false,
                missingSlots: [],
                slots: mergeSlots(semanticFrame.slots, {}),
                routeMethod: 'rule'
            };
        }
        // 否则是 vision
        return {
            intent: INTENT_TYPES.VISION,
            confidence: 0.85,
            clarificationNeeded: false,
            missingSlots: [],
            slots: mergeSlots(semanticFrame.slots, {}),
            routeMethod: 'rule'
        };
    }
    
    // 规则匹配
    let intentResult = matchIntentByRule(message, lang);
    
    // 规则匹配失败 → LLM fallback
    if (!intentResult) {
        intentResult = await routeIntentWithLLM(message, semanticFrame, sanitizedHistory, context);
    }
    
    // 合并槽位
    const mergedSlots = mergeSlots(semanticFrame.slots, {});
    
    // 检查是否需要澄清
    const clarificationCheck = checkClarificationNeeded(intentResult, semanticFrame, mergedSlots);
    
    const result = {
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        clarificationNeeded: clarificationCheck.needed,
        missingSlots: clarificationCheck.missingSlots,
        slots: mergedSlots,
        routeMethod: intentResult.routeMethod,
        clarificationReason: clarificationCheck.reason
    };
    
    context?.log?.(`[Stage5] IntentRouter: intent=${result.intent}(${result.confidence}) method=${result.routeMethod} clarify=${result.clarificationNeeded} missing=${result.missingSlots.join(',') || 'none'}`);
    
    return result;
}

module.exports = {
    routeIntent,
    matchIntentByRule,
    routeIntentWithLLM,
    checkClarificationNeeded,
    mergeSlots,
    INTENT_TYPES,
    RULE_BASED_INTENTS
};
