/**
 * Stage 4: Semantic Resolver - 语义解析器
 * 
 * 职责：
 * - 判断"这句话是否依赖上下文"
 * - 检测"是否缺关键槽位"
 * - 判断"是否像工具请求"
 * - 不做最终 intent 判定
 * 
 * 输出：SemanticFrame
 */

/**
 * 主题类型
 */
const SUBJECT_TYPES = {
    SCHEDULE: 'schedule',       // 课表相关
    WEATHER: 'weather',         // 天气相关
    PLAN: 'plan',               // 计划/规划相关
    SEARCH: 'search',           // 搜索/查询
    IDENTITY: 'identity',       // 身份/自我介绍
    CHAT: 'chat',               // 闲聊
    UNKNOWN: 'unknown'          // 未知
};

/**
 * 槽位定义
 */
const SLOT_DEFINITIONS = {
    schedule: {
        required: [],
        optional: ['date', 'dayOfWeek', 'timeRange', 'courseName'],
        dataDependent: ['scheduleData']  // 依赖外部数据
    },
    weather: {
        required: ['location'],
        optional: ['date', 'timeRange'],
        dataDependent: []
    },
    plan: {
        required: ['target'],
        optional: ['dateRange', 'duration', 'constraints'],
        dataDependent: ['scheduleData']
    },
    search: {
        required: ['query'],
        optional: ['scope', 'filters'],
        dataDependent: []
    }
};

/**
 * 上下文依赖模式
 */
const CONTEXT_DEPENDENCY_PATTERNS = {
    // 代词引用
    pronounReference: {
        zh: /^(这|那|它|他|她|这个|那个|这些|那些|上面|下面)/,
        en: /^(this|that|it|they|these|those|above|below)/i
    },
    // 省略主语
    ellipsis: {
        zh: /^(怎么样|如何|好不好|行不行|可以吗|能吗)/,
        en: /^(how about|what about|is it|can it|will it)/i
    },
    // 续问
    followUp: {
        zh: /(然后呢|接下来|还有吗|继续|再说说|详细说说)/,
        en: /(then what|what next|anything else|continue|go on|tell me more)/i
    },
    // 对比/选择
    comparison: {
        zh: /(和|跟).*(比|相比|对比|哪个)/,
        en: /(compare|vs|versus|which one|better)/i
    }
};

/**
 * 主题检测模式
 */
const SUBJECT_PATTERNS = {
    schedule: {
        zh: [
            /(课表|课程|上课|下课|第\d+节|几点.*课)/,
            /(明天|今天|后天|周[一二三四五六日天]|下周).*(课|有什么)/,
            /(空闲|空档|没课|有课)/
        ],
        en: [
            /(schedule|class|course|lecture|lesson)/i,
            /(tomorrow|today|next\s+\w+day).*(class|have)/i,
            /(free\s+time|available|no\s+class)/i
        ]
    },
    weather: {
        zh: [
            /(天气|气温|温度|下雨|下雪|晴|阴|多云)/,
            /(会不会.*雨|需要.*伞|穿.*衣服)/
        ],
        en: [
            /(weather|temperature|rain|snow|sunny|cloudy)/i,
            /(will\s+it\s+rain|need.*umbrella|what\s+to\s+wear)/i
        ]
    },
    plan: {
        zh: [
            /(计划|规划|安排|怎么.*时间|如何.*学习)/,
            /(复习|预习|准备|备考)/,
            /(帮我.*安排|给我.*计划)/
        ],
        en: [
            /(plan|schedule|arrange|how\s+to.*time)/i,
            /(review|prepare|study\s+for)/i,
            /(help\s+me.*plan|make.*plan)/i
        ]
    },
    search: {
        zh: [
            /(搜索|查询|查一下|找一下|百度|谷歌)/,
            /(是什么|什么是|怎么回事|为什么)/,
            /(资料|文档|论文|政策)/
        ],
        en: [
            /(search|look\s+up|find|google)/i,
            /(what\s+is|what\s+are|how\s+does|why)/i,
            /(document|paper|policy|information)/i
        ]
    },
    identity: {
        zh: [/(你是谁|你叫什么|介绍.*自己|你是.*AI)/],
        en: [/(who\s+are\s+you|what\s+are\s+you|introduce\s+yourself)/i]
    }
};

/**
 * 槽位提取模式
 */
const SLOT_EXTRACTORS = {
    date: {
        zh: [
            { pattern: /今天/, value: 'today' },
            { pattern: /明天/, value: 'tomorrow' },
            { pattern: /后天/, value: 'day_after_tomorrow' },
            { pattern: /昨天/, value: 'yesterday' },
            { pattern: /下周([一二三四五六日天])/, extract: (m) => `next_${['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']['一二三四五六日天'.indexOf(m[1])]}` },
            { pattern: /周([一二三四五六日天])/, extract: (m) => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']['一二三四五六日天'.indexOf(m[1])] },
            { pattern: /(\d{1,2})月(\d{1,2})[日号]/, extract: (m) => `${m[1]}-${m[2]}` }
        ],
        en: [
            { pattern: /today/i, value: 'today' },
            { pattern: /tomorrow/i, value: 'tomorrow' },
            { pattern: /yesterday/i, value: 'yesterday' },
            { pattern: /next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i, extract: (m) => `next_${m[1].toLowerCase().slice(0, 3)}` },
            { pattern: /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i, extract: (m) => m[1].toLowerCase().slice(0, 3) }
        ]
    },
    location: {
        zh: [
            { pattern: /(武汉|北京|上海|广州|深圳|杭州|成都|西安|南京|重庆|天津|苏州|郑州|长沙|青岛|沈阳|大连|厦门|福州|济南|合肥|昆明|贵阳|南昌|太原|哈尔滨|长春)/, extract: (m) => m[1] }
        ],
        en: [
            { pattern: /(wuhan|beijing|shanghai|guangzhou|shenzhen|hangzhou|chengdu|xi'an|nanjing|chongqing)/i, extract: (m) => m[1] }
        ]
    },
    target: {
        zh: [
            { pattern: /(学习|复习|预习|运动|锻炼|阅读|写作|编程|做作业)/, extract: (m) => m[1] },
            { pattern: /准备(.*?)(考试|面试|比赛|答辩)/, extract: (m) => `prepare_${m[2]}` }
        ],
        en: [
            { pattern: /(study|review|exercise|read|write|code|homework)/i, extract: (m) => m[1].toLowerCase() },
            { pattern: /prepare\s+for\s+(\w+)/i, extract: (m) => `prepare_${m[1]}` }
        ]
    }
};

/**
 * @typedef {Object} SemanticFrame
 * @property {string} subject - 主题类型
 * @property {number} subjectConfidence - 主题置信度
 * @property {boolean} dependsOnContext - 是否依赖上下文
 * @property {string} contextDependencyReason - 上下文依赖原因
 * @property {Object} slots - 提取的槽位
 * @property {Array<string>} missingSlots - 缺失的必要槽位
 * @property {boolean} standaloneSemanticValidity - 独立语义有效性
 * @property {boolean} looksLikeToolRequest - 是否像工具请求
 * @property {string} enhancedMessage - 增强后的消息（补全上下文后）
 */

/**
 * 检测主题
 */
function detectSubject(msg, lang) {
    for (const [subject, patterns] of Object.entries(SUBJECT_PATTERNS)) {
        const langPatterns = patterns[lang] || patterns['zh'];
        for (const pattern of langPatterns) {
            if (pattern.test(msg)) {
                return { subject, confidence: 0.8 };
            }
        }
    }
    return { subject: SUBJECT_TYPES.UNKNOWN, confidence: 0.3 };
}

/**
 * 检测上下文依赖
 */
function detectContextDependency(msg, lang) {
    for (const [reason, patterns] of Object.entries(CONTEXT_DEPENDENCY_PATTERNS)) {
        const pattern = patterns[lang] || patterns['zh'];
        if (pattern.test(msg)) {
            return { depends: true, reason };
        }
    }
    return { depends: false, reason: null };
}

/**
 * 提取槽位
 */
function extractSlots(msg, lang) {
    const slots = {};
    
    for (const [slotName, extractors] of Object.entries(SLOT_EXTRACTORS)) {
        const langExtractors = extractors[lang] || extractors['zh'];
        for (const extractor of langExtractors) {
            const match = msg.match(extractor.pattern);
            if (match) {
                slots[slotName] = extractor.extract ? extractor.extract(match) : extractor.value;
                break;
            }
        }
    }
    
    return slots;
}

/**
 * 检查缺失槽位
 */
function checkMissingSlots(subject, slots) {
    const definition = SLOT_DEFINITIONS[subject];
    if (!definition) return [];
    
    const missing = [];
    for (const required of definition.required) {
        if (!slots[required]) {
            missing.push(required);
        }
    }
    
    return missing;
}

/**
 * 尝试从历史中补全上下文
 */
function enhanceWithHistory(msg, history, contextDependency) {
    if (!contextDependency.depends || !history?.length) {
        return msg;
    }
    
    // 从最近的历史中提取上下文
    const recentHistory = history.slice(-4);
    let context = '';
    
    // 提取最近提到的主题/实体
    for (const entry of recentHistory) {
        if (entry.role === 'user') {
            // 提取城市
            const cityMatch = entry.content?.match(/(武汉|北京|上海|广州|深圳|杭州|成都|西安)/);
            if (cityMatch) context += `[城市:${cityMatch[1]}]`;
            
            // 提取课程
            const courseMatch = entry.content?.match(/(大学英语|高等数学|线性代数|物理|化学|编程|数据结构)/);
            if (courseMatch) context += `[课程:${courseMatch[1]}]`;
            
            // 提取日期
            const dateMatch = entry.content?.match(/(今天|明天|后天|周[一二三四五六日天])/);
            if (dateMatch) context += `[日期:${dateMatch[1]}]`;
        }
    }
    
    if (context) {
        return `[上下文:${context}] ${msg}`;
    }
    
    return msg;
}

/**
 * 判断是否像工具请求
 */
function looksLikeToolRequest(msg, subject, slots) {
    // 有明确主题且不是闲聊
    if (subject !== SUBJECT_TYPES.UNKNOWN && subject !== SUBJECT_TYPES.CHAT) {
        return true;
    }
    
    // 有提取到槽位
    if (Object.keys(slots).length > 0) {
        return true;
    }
    
    // 包含动作词
    const actionPatterns = {
        zh: /(查|看|找|帮我|告诉我|显示|列出)/,
        en: /(check|show|find|help\s+me|tell\s+me|list|display)/i
    };
    
    return actionPatterns.zh.test(msg) || actionPatterns.en.test(msg);
}

/**
 * 主入口：语义解析
 * @param {Object} requestContext - 标准化后的请求上下文
 * @param {Array} sanitizedHistory - 清洗后的历史
 * @param {Object} context - Azure Functions context
 * @returns {SemanticFrame}
 */
function resolveSemantics(requestContext, sanitizedHistory, context) {
    const { message, lang } = requestContext;
    
    // 检测主题
    const { subject, confidence: subjectConfidence } = detectSubject(message, lang);
    
    // 检测上下文依赖
    const contextDependency = detectContextDependency(message, lang);
    
    // 提取槽位
    const slots = extractSlots(message, lang);
    
    // 检查缺失槽位
    const missingSlots = checkMissingSlots(subject, slots);
    
    // 尝试从历史补全
    const enhancedMessage = enhanceWithHistory(message, sanitizedHistory, contextDependency);
    
    // 判断独立语义有效性
    const standaloneSemanticValidity = !contextDependency.depends && missingSlots.length === 0;
    
    // 判断是否像工具请求
    const isToolRequest = looksLikeToolRequest(message, subject, slots);
    
    const frame = {
        subject,
        subjectConfidence,
        dependsOnContext: contextDependency.depends,
        contextDependencyReason: contextDependency.reason,
        slots,
        missingSlots,
        standaloneSemanticValidity,
        looksLikeToolRequest: isToolRequest,
        enhancedMessage: enhancedMessage !== message ? enhancedMessage : null
    };
    
    context?.log?.(`[Stage4] SemanticResolver: subject=${subject}(${subjectConfidence}) dependsOnContext=${contextDependency.depends} slots=${JSON.stringify(slots)} missing=${missingSlots.join(',') || 'none'}`);
    
    return frame;
}

module.exports = {
    resolveSemantics,
    detectSubject,
    detectContextDependency,
    extractSlots,
    checkMissingSlots,
    enhanceWithHistory,
    looksLikeToolRequest,
    SUBJECT_TYPES,
    SLOT_DEFINITIONS,
    CONTEXT_DEPENDENCY_PATTERNS,
    SUBJECT_PATTERNS,
    SLOT_EXTRACTORS
};
