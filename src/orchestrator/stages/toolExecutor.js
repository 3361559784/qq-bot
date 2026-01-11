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
        // TODO: 实际工具调用
        // const handler = require(`./tools/${tool.handler}`);
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
            lang: requestContext.lang
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
