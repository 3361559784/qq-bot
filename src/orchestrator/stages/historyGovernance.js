/**
 * Stage 1: History Governance - 历史治理
 * 
 * 职责：
 * - 从 DB 读取历史
 * - 分离 raw（审计用）和 sanitized（推理用）
 * - 过滤污染模板（拒绝话术、系统模板、工具错误堆栈）
 * 
 * 输出：HistoryBundle
 */

/**
 * 污染模式配置
 * 结构化管理，支持不同处理策略
 */
const POLLUTION_TEMPLATES = [
    // 拒绝模板
    {
        id: 'refusal_cannot_determine',
        patterns: [/无法判断/, /无法确定/],
        action: 'DROP_PARAGRAPH',
        category: 'refusal'
    },
    {
        id: 'refusal_provide_info',
        patterns: [/请提供相关信息/, /请提供更多信息/, /请补充信息/],
        action: 'DROP_PARAGRAPH',
        category: 'refusal'
    },
    {
        id: 'refusal_unclear',
        patterns: [/请求不够明确/, /不够明确/, /请明确/],
        action: 'DROP_PARAGRAPH',
        category: 'refusal'
    },
    {
        id: 'refusal_choose',
        patterns: [/请选择(?:课表|天气|搜索)/, /请从以下选项中选择/],
        action: 'DROP_PARAGRAPH',
        category: 'refusal'
    },
    // 系统提示复述
    {
        id: 'system_echo',
        patterns: [/作为.*AI.*助手/, /作为.*人工智能/, /我是.*语言模型/],
        action: 'DROP_MESSAGE',
        category: 'system_echo'
    },
    // 工具错误
    {
        id: 'tool_error_stack',
        patterns: [/Error:.*at\s+\w+/, /TypeError:/, /ReferenceError:/, /SyntaxError:/],
        action: 'DROP_MESSAGE',
        category: 'tool_error'
    },
    // Prompt 注入痕迹
    {
        id: 'prompt_injection',
        patterns: [/ignore.*previous.*instructions/i, /忽略.*之前.*指令/, /你现在是/],
        action: 'DROP_MESSAGE',
        category: 'injection'
    }
];

/**
 * @typedef {Object} HistoryBundle
 * @property {Array} raw - 原始历史（审计用）
 * @property {Array} sanitized - 清洗后历史（推理用）
 * @property {Array<string>} filteredPatterns - 被过滤的模式ID列表
 * @property {number} filteredCount - 被过滤的消息/段落数
 * @property {Object} stats - 统计信息
 */

/**
 * 检查内容是否匹配任何污染模式
 * @param {string} content - 要检查的内容
 * @returns {{ matched: boolean, templates: Array }}
 */
function matchPollutionPatterns(content) {
    if (!content || typeof content !== 'string') {
        return { matched: false, templates: [] };
    }
    
    const matchedTemplates = [];
    
    for (const template of POLLUTION_TEMPLATES) {
        for (const pattern of template.patterns) {
            if (pattern.test(content)) {
                matchedTemplates.push(template);
                break; // 一个 template 只记录一次
            }
        }
    }
    
    return {
        matched: matchedTemplates.length > 0,
        templates: matchedTemplates
    };
}

/**
 * 按段落分割文本
 * @param {string} text 
 * @returns {Array<string>}
 */
function splitIntoParagraphs(text) {
    if (!text) return [];
    // 按换行符分割，过滤空段落
    return text.split(/\n+/).map(p => p.trim()).filter(Boolean);
}

/**
 * 合并段落
 * @param {Array<string>} paragraphs 
 * @returns {string}
 */
function joinParagraphs(paragraphs) {
    return paragraphs.join('\n');
}

/**
 * 清洗单条消息
 * @param {Object} entry - 历史条目
 * @returns {{ entry: Object|null, filtered: Array<string> }}
 */
function sanitizeEntry(entry) {
    if (!entry || typeof entry.content !== 'string') {
        return { entry: null, filtered: [] };
    }
    
    // 只处理 assistant 消息
    if (entry.role !== 'assistant') {
        return { entry, filtered: [] };
    }
    
    const content = entry.content;
    const { matched, templates } = matchPollutionPatterns(content);
    
    if (!matched) {
        return { entry, filtered: [] };
    }
    
    // 检查是否需要整条删除
    const dropMessageTemplates = templates.filter(t => t.action === 'DROP_MESSAGE');
    if (dropMessageTemplates.length > 0) {
        return {
            entry: null,
            filtered: dropMessageTemplates.map(t => t.id)
        };
    }
    
    // 按段落处理
    const paragraphs = splitIntoParagraphs(content);
    const cleanParagraphs = [];
    const filtered = [];
    
    for (const para of paragraphs) {
        const paraMatch = matchPollutionPatterns(para);
        if (paraMatch.matched) {
            // 检查是否有 DROP_PARAGRAPH
            const dropParaTemplates = paraMatch.templates.filter(t => t.action === 'DROP_PARAGRAPH');
            if (dropParaTemplates.length > 0) {
                filtered.push(...dropParaTemplates.map(t => t.id));
                continue; // 跳过这个段落
            }
        }
        cleanParagraphs.push(para);
    }
    
    // 如果所有段落都被过滤，删除整条消息
    if (cleanParagraphs.length === 0) {
        return { entry: null, filtered };
    }
    
    // 返回清洗后的条目
    return {
        entry: {
            ...entry,
            content: joinParagraphs(cleanParagraphs)
        },
        filtered
    };
}

/**
 * 清洗历史记录
 * @param {Array} history - 原始历史
 * @returns {{ sanitized: Array, filteredPatterns: Array<string>, stats: Object }}
 */
function sanitizeHistory(history) {
    if (!Array.isArray(history)) {
        return { sanitized: [], filteredPatterns: [], stats: { total: 0, kept: 0, filtered: 0 } };
    }
    
    const sanitized = [];
    const allFiltered = [];
    let filteredCount = 0;
    
    for (const entry of history) {
        const { entry: cleanEntry, filtered } = sanitizeEntry(entry);
        
        if (filtered.length > 0) {
            allFiltered.push(...filtered);
            filteredCount++;
        }
        
        if (cleanEntry) {
            sanitized.push(cleanEntry);
        }
    }
    
    // 去重 filteredPatterns
    const uniqueFiltered = [...new Set(allFiltered)];
    
    return {
        sanitized,
        filteredPatterns: uniqueFiltered,
        stats: {
            total: history.length,
            kept: sanitized.length,
            filtered: filteredCount
        }
    };
}

/**
 * 从数据库加载历史记录（占位实现）
 * @param {string} userId 
 * @param {Object} context 
 * @returns {Promise<Array>}
 */
async function loadHistoryFromDB(userId, context) {
    // TODO: 实际实现从 Cosmos DB 加载
    // 这里返回空数组作为占位
    context?.log?.(`[HistoryGovernance] Loading history for user: ${userId}`);
    return [];
}

/**
 * 主入口：历史治理
 * @param {Object} requestContext - 标准化后的请求上下文
 * @param {Object} context - Azure Functions context
 * @returns {Promise<HistoryBundle>}
 */
async function governHistory(requestContext, context) {
    const { userId, metadata } = requestContext;
    
    // 获取原始历史
    let rawHistory = [];
    
    // 优先使用传入的历史
    if (metadata?.originalInput?.history) {
        rawHistory = metadata.originalInput.history;
    } else {
        // 否则从 DB 加载
        rawHistory = await loadHistoryFromDB(userId, context);
    }
    
    // 确保是数组
    if (!Array.isArray(rawHistory)) {
        rawHistory = [];
    }
    
    // 清洗历史
    const { sanitized, filteredPatterns, stats } = sanitizeHistory(rawHistory);
    
    context?.log?.(`[Stage1] HistoryGovernance: raw=${stats.total} kept=${stats.kept} filtered=${stats.filtered} patterns=${filteredPatterns.join(',') || 'none'}`);
    
    return {
        raw: rawHistory,
        sanitized,
        filteredPatterns,
        filteredCount: stats.filtered,
        stats
    };
}

module.exports = {
    governHistory,
    sanitizeHistory,
    sanitizeEntry,
    matchPollutionPatterns,
    splitIntoParagraphs,
    joinParagraphs,
    loadHistoryFromDB,
    POLLUTION_TEMPLATES
};
