/**
 * Stage 9: Post-LLM Safety - LLM 后安全检查
 * 
 * 职责：
 * - 对 LLM 输出进行最终安全检查
 * - 过滤敏感内容
 * - 确保输出符合规范
 * 
 * 输出：FinalReply
 */

/**
 * 安全检查规则
 */
const SAFETY_RULES = {
    // 禁止输出的模式
    blockedPatterns: [
        // 系统口吻
        /作为.*AI.*助手/,
        /作为.*人工智能/,
        /我是.*语言模型/,
        // 拒绝模板（不应该在最终输出出现）
        /无法判断/,
        /请提供相关信息后再/,
        // 幻觉指示词
        /据我所知.*但我不确定/,
        /我猜测/
    ],
    
    // 需要重写的模式
    rewritePatterns: [
        {
            pattern: /无法确定/,
            replacement: '需要更多信息才能确认'
        },
        {
            pattern: /我不知道/,
            replacement: '这个信息我暂时没有'
        }
    ],
    
    // 敏感词检测
    sensitivePatterns: [
        // 政治敏感
        /政治|政府|领导人|主席|总统/,
        // 暴力
        /杀|死|暴力|伤害/,
        // 其他敏感
        /色情|赌博|毒品/
    ]
};

/**
 * @typedef {Object} FinalReply
 * @property {string} content - 最终内容
 * @property {boolean} modified - 是否被修改
 * @property {Array<string>} safetyFlags - 安全标记
 * @property {string} persona - 角色
 * @property {number} confidence - 置信度
 * @property {Array<string>} evidence - 证据引用
 * @property {Object} [voice] - 语音信息
 */

/**
 * 检查并过滤内容
 */
function checkAndFilter(content) {
    let modified = false;
    let filteredContent = content;
    const flags = [];
    
    // 检查阻止模式
    for (const pattern of SAFETY_RULES.blockedPatterns) {
        if (pattern.test(filteredContent)) {
            flags.push(`blocked:${pattern.toString()}`);
            // 移除匹配的句子
            filteredContent = filteredContent.replace(pattern, '');
            modified = true;
        }
    }
    
    // 应用重写规则
    for (const rule of SAFETY_RULES.rewritePatterns) {
        if (rule.pattern.test(filteredContent)) {
            filteredContent = filteredContent.replace(rule.pattern, rule.replacement);
            flags.push(`rewritten:${rule.pattern.toString()}`);
            modified = true;
        }
    }
    
    // 检查敏感内容（只标记，不修改）
    for (const pattern of SAFETY_RULES.sensitivePatterns) {
        if (pattern.test(filteredContent)) {
            flags.push(`sensitive:${pattern.toString()}`);
        }
    }
    
    // 清理多余空行
    filteredContent = filteredContent.replace(/\n{3,}/g, '\n\n').trim();
    
    return {
        content: filteredContent,
        modified,
        flags
    };
}

/**
 * 格式化输出
 */
function formatOutput(content) {
    // 确保表格格式正确
    // 确保列表格式正确
    // 移除多余空白
    return content
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+$/gm, '')
        .trim();
}

/**
 * 主入口：LLM 后安全检查
 * @param {Object} draftReply - LLM 草稿回复
 * @param {Object} requestContext - 请求上下文
 * @param {Object} context - Azure Functions context
 * @returns {FinalReply}
 */
function runPostLLMSafety(draftReply, requestContext, context) {
    const { content, model, tokenUsage, persona, confidence, evidence } = draftReply;
    
    // 安全检查和过滤
    const { content: filteredContent, modified, flags } = checkAndFilter(content);
    
    // 格式化输出
    const formattedContent = formatOutput(filteredContent);
    
    // 日志
    if (modified) {
        context?.log?.(`[Stage9] PostLLMSafety: content modified, flags=${flags.join(',')}`);
    } else {
        context?.log?.(`[Stage9] PostLLMSafety: no modifications needed`);
    }
    
    return {
        content: formattedContent,
        modified,
        safetyFlags: flags,
        persona,
        confidence,
        evidence,
        voice: null  // TODO: 语音生成
    };
}

module.exports = {
    runPostLLMSafety,
    checkAndFilter,
    formatOutput,
    SAFETY_RULES
};
