/**
 * Structured Logger - Pillar 2: 懂治理，可审计
 * 
 * 核心原则：让每一次对话都有据可查，把"黑盒"变成"透明盒"
 * 实现方式：结构化事件日志 (Structured Event Logging)
 */

// ==========================================
// 📊 事件类型定义
// ==========================================

const EventType = Object.freeze({
    // 请求生命周期
    REQUEST_START: 'request_start',
    REQUEST_END: 'request_end',
    
    // 安全相关
    SAFETY_CHECK: 'safety_check',
    SAFETY_BLOCKED: 'safety_blocked',
    
    // 意图路由
    INTENT_DETECTED: 'intent_detected',
    PERSONA_SWITCHED: 'persona_switched',
    
    // 工具调用
    TOOL_CALLED: 'tool_called',
    TOOL_FALLBACK: 'tool_fallback',
    TOOL_ERROR: 'tool_error',
    
    // 数据源
    DATA_SOURCE_HIT: 'data_source_hit',
    DATA_SOURCE_MISS: 'data_source_miss',
    
    // LLM 调用
    LLM_CALL_START: 'llm_call_start',
    LLM_CALL_END: 'llm_call_end',
    LLM_FALLBACK: 'llm_fallback',
    
    // 错误
    ERROR: 'error',
    WARNING: 'warning'
});

// ==========================================
// 🎯 核心 Logger 类
// ==========================================

class StructuredLogger {
    constructor(context, requestId) {
        this.context = context;
        this.requestId = requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.startTime = Date.now();
        this.events = [];
        this.metadata = {
            requestId: this.requestId,
            startTime: new Date().toISOString()
        };
    }

    /**
     * 记录结构化事件
     * @param {string} eventName - 事件名称 (使用 EventType)
     * @param {object} properties - 事件属性
     */
    logEvent(eventName, properties = {}) {
        const event = {
            event: eventName,
            requestId: this.requestId,
            timestamp: new Date().toISOString(),
            elapsed_ms: Date.now() - this.startTime,
            ...properties
        };
        
        // 存储到内存（用于最终汇总）
        this.events.push(event);
        
        // 输出到 Application Insights / Azure Functions 日志
        const logLine = JSON.stringify(event);
        
        if (this.context?.log) {
            // 根据事件类型选择日志级别
            if (eventName === EventType.ERROR || eventName === EventType.SAFETY_BLOCKED) {
                this.context.log.error?.(logLine) || this.context.log(logLine);
            } else if (eventName === EventType.WARNING || eventName === EventType.TOOL_FALLBACK) {
                this.context.log.warn?.(logLine) || this.context.log(logLine);
            } else {
                this.context.log(logLine);
            }
        } else {
            console.log(logLine);
        }
        
        return event;
    }

    /**
     * 记录请求开始
     */
    logRequestStart(userId, intent, mode) {
        return this.logEvent(EventType.REQUEST_START, {
            user_id: userId,
            initial_intent: intent,
            mode: mode
        });
    }

    /**
     * 记录请求结束
     */
    logRequestEnd(status, responseLength) {
        return this.logEvent(EventType.REQUEST_END, {
            status,
            response_length: responseLength,
            total_latency_ms: Date.now() - this.startTime
        });
    }

    /**
     * 记录安全检查结果
     */
    logSafetyCheck(result, category, action, matched = null) {
        return this.logEvent(EventType.SAFETY_CHECK, {
            safety_result: result,  // PASS | BLOCKED | DEGRADED
            safety_category: category,
            safety_action: action,
            matched_pattern: matched ? '[PATTERN]' : null  // 不记录具体 pattern 避免泄露规则
        });
    }

    /**
     * 记录安全阻断
     */
    logSafetyBlocked(category, reason) {
        return this.logEvent(EventType.SAFETY_BLOCKED, {
            safety_category: category,
            block_reason: reason
        });
    }

    /**
     * 记录意图检测
     */
    logIntentDetected(tool, intent, confidence, needsTools = {}) {
        return this.logEvent(EventType.INTENT_DETECTED, {
            detected_tool: tool,
            detected_intent: intent,
            confidence: confidence,
            needs_schedule: needsTools.schedule || false,
            needs_weather: needsTools.weather || false,
            needs_search: needsTools.search || false
        });
    }

    /**
     * 记录人格切换
     */
    logPersonaSwitched(from, to, reason) {
        return this.logEvent(EventType.PERSONA_SWITCHED, {
            persona_from: from,
            persona_to: to,
            switch_reason: reason
        });
    }

    /**
     * 记录工具调用
     */
    logToolCalled(toolName, success, latencyMs, source = null) {
        return this.logEvent(EventType.TOOL_CALLED, {
            tool: toolName,
            success: success,
            latency_ms: latencyMs,
            data_source: source
        });
    }

    /**
     * 记录工具降级
     */
    logToolFallback(toolName, fromSource, toSource, reason) {
        return this.logEvent(EventType.TOOL_FALLBACK, {
            tool: toolName,
            fallback_from: fromSource,
            fallback_to: toSource,
            fallback_reason: reason
        });
    }

    /**
     * 记录工具错误
     */
    logToolError(toolName, errorMessage, errorCode = null) {
        return this.logEvent(EventType.TOOL_ERROR, {
            tool: toolName,
            error_message: errorMessage,
            error_code: errorCode
        });
    }

    /**
     * 记录数据源命中
     */
    logDataSourceHit(sourceName, recordCount = null) {
        return this.logEvent(EventType.DATA_SOURCE_HIT, {
            source: sourceName,
            record_count: recordCount
        });
    }

    /**
     * 记录数据源未命中
     */
    logDataSourceMiss(sourceName, reason = null) {
        return this.logEvent(EventType.DATA_SOURCE_MISS, {
            source: sourceName,
            miss_reason: reason
        });
    }

    /**
     * 记录 LLM 调用开始
     */
    logLLMCallStart(layer, model) {
        return this.logEvent(EventType.LLM_CALL_START, {
            llm_layer: layer,  // 'L1_intent' | 'L2_response'
            model: model
        });
    }

    /**
     * 记录 LLM 调用结束
     */
    logLLMCallEnd(layer, model, latencyMs, tokenCount = null) {
        return this.logEvent(EventType.LLM_CALL_END, {
            llm_layer: layer,
            model: model,
            latency_ms: latencyMs,
            token_count: tokenCount
        });
    }

    /**
     * 记录 LLM 降级
     */
    logLLMFallback(fromModel, toModel, reason) {
        return this.logEvent(EventType.LLM_FALLBACK, {
            fallback_from: fromModel,
            fallback_to: toModel,
            fallback_reason: reason
        });
    }

    /**
     * 记录错误
     */
    logError(errorType, message, stack = null) {
        return this.logEvent(EventType.ERROR, {
            error_type: errorType,
            error_message: message,
            stack_trace: stack ? stack.split('\n').slice(0, 3).join(' | ') : null
        });
    }

    /**
     * 记录警告
     */
    logWarning(warningType, message) {
        return this.logEvent(EventType.WARNING, {
            warning_type: warningType,
            warning_message: message
        });
    }

    /**
     * 获取请求摘要（用于 meta 返回）
     */
    getSummary() {
        const safetyEvents = this.events.filter(e => e.event.startsWith('safety_'));
        const toolEvents = this.events.filter(e => e.event.startsWith('tool_'));
        const fallbackEvents = this.events.filter(e => e.event.includes('fallback'));
        
        return {
            requestId: this.requestId,
            totalLatencyMs: Date.now() - this.startTime,
            eventCount: this.events.length,
            safetyChecks: safetyEvents.length,
            toolCalls: toolEvents.length,
            fallbacks: fallbackEvents.length,
            hadSafetyBlock: safetyEvents.some(e => e.safety_result === 'BLOCKED'),
            dataSources: [...new Set(this.events.filter(e => e.data_source).map(e => e.data_source))]
        };
    }

    /**
     * 获取所有事件（用于调试）
     */
    getAllEvents() {
        return this.events;
    }
}

// ==========================================
// 🏭 工厂函数
// ==========================================

/**
 * 创建 Logger 实例
 * @param {object} context - Azure Functions context
 * @param {string} requestId - 请求 ID
 * @returns {StructuredLogger}
 */
function createLogger(context, requestId) {
    return new StructuredLogger(context, requestId);
}

// ==========================================
// 📊 导出
// ==========================================

module.exports = {
    EventType,
    StructuredLogger,
    createLogger
};
