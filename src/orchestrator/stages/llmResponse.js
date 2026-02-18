/**
 * Stage 8: LLM Response - LLM 回复生成
 * 
 * 职责：
 * - 构建 Prompt（边界、证据引用、禁止编造、输出 schema）
 * - 调用 LLM 生成回复
 * 
 * 输出：DraftReply
 */

/**
 * System Prompt 模板
 */
const SYSTEM_PROMPTS = {
    professional: {
        zh: `你是校园 AI 助手 Aris (Campus Copilot) - 专业模式。

【核心定位】
- 严肃、客观、数据驱动：你是学生的决策支持系统
- 输出格式化、结构化：优先使用表格、条目、时间轴
- 语言克制、去修饰：不使用感叹号、颜文字
- 边界清晰、拒绝明确：缺数据时直接说明缺口，不编造

【核心能力】
1. 课程信息整合：快速查询课表、教室位置、课程时间
2. 学习任务规划：基于课表空档把学习/复习安排落地
3. 校园生活效率提升：整合课程、活动、天气等碎片化信息

【格式规范】
- 展示课表、多日数据时必须使用 Markdown 表格
- 列表信息使用条目格式

【绝对红线】
- ❌ 编造数据（周次、课程、考试时间等）
- ❌ 过度修饰（感叹号、颜文字）
- ❌ 使用"无法判断"等系统口吻
- ❌ 没有依据的时间承诺

【数据缺失处理】
- 缺课表："暂无课表数据，请先导入课表"
- 缺周次："无法确定当前周次，需要校历信息"
- 不确定："该信息无法确认，建议核实"`,

        en: `You are Aris (Campus Copilot), a campus AI assistant in Professional Mode.

【Core Positioning】
- Serious, objective, data-driven: You are a decision support system for students
- Formatted, structured output: Prioritize tables, bullet points, timelines
- Restrained language: No exclamation marks, emoticons
- Clear boundaries: State data gaps directly, never fabricate

【Core Capabilities】
1. Course information integration: Quick schedule queries, classroom locations, course times
2. Study task planning: Schedule study/review based on free slots in timetable
3. Campus life efficiency: Integrate courses, activities, weather, etc.

【Format Standards】
- Use Markdown tables for schedules and multi-day data
- Use bullet points for lists

【Absolute Red Lines】
- ❌ Fabricate data (week numbers, courses, exam times, etc.)
- ❌ Over-embellish (exclamation marks, emoticons)
- ❌ Use system-speak like "unable to determine"
- ❌ Make time commitments without evidence

【Missing Data Handling】
- No schedule: "No schedule data available, please import your schedule first"
- No week number: "Cannot determine current week, need academic calendar"
- Uncertain: "This information cannot be confirmed, please verify"`
    }
};

/**
 * @typedef {Object} DraftReply
 * @property {string} content - 回复内容
 * @property {string} model - 使用的模型
 * @property {Object} tokenUsage - token 使用情况
 * @property {string} persona - 角色
 * @property {number} confidence - 置信度
 * @property {Array<string>} evidence - 证据引用
 */

/**
 * 构建 Prompt
 */
function buildPrompt(requestContext, intentResult, toolOutputs, history, context) {
    const { message, lang } = requestContext;
    const { intent, slots } = intentResult;
    
    const systemPrompt = SYSTEM_PROMPTS.professional[lang] || SYSTEM_PROMPTS.professional['zh'];
    
    // 构建工具结果上下文
    let toolContext = '';
    if (toolOutputs.calls.length > 0) {
        toolContext = '\n\n【工具调用结果】\n';
        for (const call of toolOutputs.calls) {
            if (call.success && call.result) {
                toolContext += `- ${call.name}: ${JSON.stringify(call.result)}\n`;
            } else if (!call.success) {
                toolContext += `- ${call.name}: 调用失败 (${call.error})\n`;
            }
        }
    }
    
    // 构建消息列表
    const messages = [
        { role: 'system', content: systemPrompt + toolContext }
    ];
    
    // 添加历史（最近几轮）
    const recentHistory = history.slice(-6);
    for (const entry of recentHistory) {
        messages.push({
            role: entry.role,
            content: entry.content
        });
    }
    
    // 添加当前消息
    messages.push({
        role: 'user',
        content: message
    });
    
    return messages;
}

/**
 * 调用 LLM
 */
async function callLLM(messages, context) {
    // TODO: 实际 LLM 调用
    // const client = new OpenAI({ ... });
    // const response = await client.chat.completions.create({ ... });
    
    context?.log?.(`[LLMResponse] Calling LLM with ${messages.length} messages`);
    
    // 占位实现
    // Use the latest user message (history can contain older user turns).
    let userMessage = '';
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            userMessage = messages[i]?.content || '';
            break;
        }
    }
    
    // 简单的规则响应（用于测试）
    let content = '我收到了你的消息，但 LLM 调用尚未实现。';
    
    if (/课表|schedule/i.test(userMessage)) {
        content = '暂无课表数据。如果你把课表发给我（截图/文件/链接），我可以帮你导入和查询。';
    } else if (/天气|weather/i.test(userMessage)) {
        content = '天气查询功能正在对接中。';
    } else if (/计划|plan/i.test(userMessage)) {
        content = '要制定计划，我需要先了解你的课表。请先导入课表，这样我才能基于你的真实空档时间来安排。';
    }
    
    return {
        content,
        model: 'placeholder',
        tokenUsage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0
        }
    };
}

/**
 * 主入口：LLM 回复生成
 * @param {Object} requestContext - 请求上下文
 * @param {Object} intentResult - 意图路由结果
 * @param {Object} toolOutputs - 工具输出
 * @param {Array} sanitizedHistory - 清洗后的历史
 * @param {Object} context - Azure Functions context
 * @returns {Promise<DraftReply>}
 */
async function generateLLMResponse(requestContext, intentResult, toolOutputs, sanitizedHistory, context) {
    // If tools already produced a deterministic reply, prefer it (no LLM needed).
    const scheduleReply = toolOutputs?.aggregatedData?.schedule_query?.replyText;
    if (typeof scheduleReply === 'string' && scheduleReply.trim()) {
        return {
            content: scheduleReply.trim(),
            model: 'deterministic(schedule_query)',
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            persona: 'professional',
            confidence: 1.0,
            evidence: toolOutputs.calls
                .filter(c => c?.success && c?.evidenceRef)
                .map(c => c.evidenceRef)
        };
    }

    // 构建 Prompt
    const messages = buildPrompt(requestContext, intentResult, toolOutputs, sanitizedHistory, context);
    
    // 调用 LLM
    const startTime = Date.now();
    const llmResult = await callLLM(messages, context);
    const latencyMs = Date.now() - startTime;
    
    context?.log?.(`[Stage8] LLMResponse: model=${llmResult.model} latency=${latencyMs}ms tokens=${llmResult.tokenUsage?.totalTokens || 0}`);
    
    // 构建证据引用
    const evidence = [];
    for (const call of toolOutputs.calls) {
        if (call.success && call.evidenceRef) {
            evidence.push(call.evidenceRef);
        }
    }
    
    return {
        content: llmResult.content,
        model: llmResult.model,
        tokenUsage: llmResult.tokenUsage,
        persona: 'professional',
        confidence: 0.9,
        evidence
    };
}

module.exports = {
    generateLLMResponse,
    buildPrompt,
    callLLM,
    SYSTEM_PROMPTS
};
