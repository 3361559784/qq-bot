/**
 * Pipeline Logger - 管线日志器
 * 
 * 结构化日志，支持：
 * - 阶段级日志
 * - 决策日志
 * - 错误日志
 * - 性能追踪
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} timestamp - ISO 时间戳
 * @property {string} level - 日志级别
 * @property {string} stage - 阶段名称
 * @property {string} message - 日志消息
 * @property {Object} data - 附加数据
 */

class PipelineLogger {
    constructor(context) {
        this.context = context;
        this.entries = [];
        this.startTime = Date.now();
    }
    
    /**
     * 记录阶段日志
     */
    logStage(stageNum, stageName, data = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            stage: `Stage${stageNum}:${stageName}`,
            message: `Completed ${stageName}`,
            data,
            elapsedMs: Date.now() - this.startTime
        };
        
        this.entries.push(entry);
        this.context?.log?.(`[Pipeline] ${entry.stage} - ${JSON.stringify(data)}`);
    }
    
    /**
     * 记录决策日志
     */
    logDecision(decision, meta = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            stage: 'Decision',
            message: `Decision: ${decision}`,
            data: {
                decision,
                ...meta
            },
            elapsedMs: Date.now() - this.startTime
        };
        
        this.entries.push(entry);
        this.context?.log?.(`[Pipeline] DECISION=${decision} stage=${meta.stage} ruleId=${meta.ruleId || 'none'} confidence=${meta.confidence || 'N/A'}`);
    }
    
    /**
     * 记录错误日志
     */
    logError(stage, error) {
        const entry = {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            stage,
            message: error.message,
            data: {
                name: error.name,
                stack: error.stack
            },
            elapsedMs: Date.now() - this.startTime
        };
        
        this.entries.push(entry);
        this.context?.log?.(`[Pipeline] ERROR in ${stage}: ${error.message}`);
    }
    
    /**
     * 记录工具调用
     */
    logToolCall(toolName, startTime, success, result = null) {
        const latencyMs = Date.now() - startTime;
        const entry = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            stage: 'ToolCall',
            message: `Tool: ${toolName}`,
            data: {
                toolName,
                success,
                latencyMs,
                hasResult: !!result
            },
            elapsedMs: Date.now() - this.startTime
        };
        
        this.entries.push(entry);
        this.context?.log?.(`[Pipeline] TOOL=${toolName} success=${success} latency=${latencyMs}ms`);
    }
    
    /**
     * 记录 LLM 调用
     */
    logLLMCall(model, startTime, tokenUsage = null) {
        const latencyMs = Date.now() - startTime;
        const entry = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            stage: 'LLMCall',
            message: `LLM: ${model}`,
            data: {
                model,
                latencyMs,
                tokenUsage
            },
            elapsedMs: Date.now() - this.startTime
        };
        
        this.entries.push(entry);
        this.context?.log?.(`[Pipeline] LLM=${model} latency=${latencyMs}ms tokens=${JSON.stringify(tokenUsage || {})}`);
    }
    
    /**
     * 获取所有日志条目
     */
    getEntries() {
        return this.entries;
    }
    
    /**
     * 获取摘要
     */
    getSummary() {
        const totalMs = Date.now() - this.startTime;
        const decisions = this.entries.filter(e => e.stage === 'Decision');
        const errors = this.entries.filter(e => e.level === 'ERROR');
        const toolCalls = this.entries.filter(e => e.stage === 'ToolCall');
        const llmCalls = this.entries.filter(e => e.stage === 'LLMCall');
        
        return {
            totalLatencyMs: totalMs,
            stageCount: this.entries.filter(e => e.stage.startsWith('Stage')).length,
            decisions: decisions.map(d => d.data.decision),
            errorCount: errors.length,
            toolCallCount: toolCalls.length,
            llmCallCount: llmCalls.length
        };
    }
}

module.exports = {
    PipelineLogger
};
