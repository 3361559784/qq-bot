/**
 * Decision Pipeline Orchestrator
 * 
 * 主决策管线：将意图识别/澄清/拒绝/工具调用/回复生成
 * 从散落的 if-else 变成明确的10阶段决策管线
 * 
 * Stage 0: Normalize          → RequestContext
 * Stage 1: History Governance → HistoryBundle
 * Stage 2: Eligibility Gate   → EligibilityResult
 * Stage 3: Deterministic Fastpaths → FastPathResult?
 * Stage 4: Semantic Resolver  → SemanticFrame
 * Stage 5: Intent Router      → IntentResult
 * Stage 6: Context Sufficiency → SufficiencyResult
 * Stage 7: Execute (Tools)    → ToolOutputs
 * Stage 8: LLM Response       → DraftReply
 * Stage 9: Post-LLM Safety    → FinalReply
 * Stage 10: Audit + Storage   → AuditRecord
 */

const { normalizeRequest } = require('./stages/normalize');
const { governHistory } = require('./stages/historyGovernance');
const { runEligibilityGate } = require('../gates/eligibilityGate');
const { runDeterministicFastpaths } = require('./stages/deterministicFastpaths');
const { resolveSemantics } = require('./stages/semanticResolver');
const { routeIntent } = require('../router/intentRouter');
const { checkContextSufficiency } = require('./stages/contextSufficiency');
const { executeTools } = require('./stages/toolExecutor');
const { generateLLMResponse } = require('./stages/llmResponse');
const { runPostLLMSafety } = require('./stages/postLLMSafety');
const { recordAudit } = require('../observability/auditLogger');
const { PipelineLogger } = require('../observability/pipelineLogger');

/**
 * @typedef {Object} PipelineInput
 * @property {string} message - 用户消息
 * @property {string} userId - 用户ID
 * @property {string} source - 来源 (qq|web)
 * @property {Object} [rawHistory] - 原始历史记录
 * @property {Object} [metadata] - 额外元数据
 */

/**
 * @typedef {Object} PipelineOutput
 * @property {number} status - HTTP状态码
 * @property {Object} body - 响应体
 * @property {Object} meta - 决策元数据
 * @property {Object} audit - 审计记录
 */

/**
 * 决策管线主入口
 * @param {PipelineInput} input 
 * @param {Object} context - Azure Functions context
 * @returns {Promise<PipelineOutput>}
 */
async function runDecisionPipeline(input, context) {
    const logger = new PipelineLogger(context);
    const startTime = Date.now();
    
    // 初始化审计记录
    const audit = {
        requestId: null,
        stages: [],
        decisions: [],
        toolCalls: [],
        llmCalls: [],
        totalLatencyMs: 0
    };

    try {
        // ═══════════════════════════════════════════════════════════════
        // Stage 0: Normalize - 输入标准化
        // ═══════════════════════════════════════════════════════════════
        const stageStart0 = Date.now();
        const requestContext = normalizeRequest(input, context);
        audit.requestId = requestContext.requestId;
        audit.stages.push({
            stage: 0,
            name: 'normalize',
            latencyMs: Date.now() - stageStart0,
            output: { lang: requestContext.lang, source: requestContext.source }
        });
        logger.logStage(0, 'Normalize', { requestId: requestContext.requestId, lang: requestContext.lang });

        // ═══════════════════════════════════════════════════════════════
        // Stage 1: History Governance - 历史治理
        // ═══════════════════════════════════════════════════════════════
        const stageStart1 = Date.now();
        const historyBundle = await governHistory(requestContext, context);
        audit.stages.push({
            stage: 1,
            name: 'history_governance',
            latencyMs: Date.now() - stageStart1,
            output: {
                rawCount: historyBundle.raw.length,
                sanitizedCount: historyBundle.sanitized.length,
                filteredCount: historyBundle.filteredPatterns.length
            }
        });
        logger.logStage(1, 'HistoryGovernance', {
            rawCount: historyBundle.raw.length,
            sanitizedCount: historyBundle.sanitized.length,
            filteredPatterns: historyBundle.filteredPatterns
        });

        // ═══════════════════════════════════════════════════════════════
        // Stage 2: Eligibility Gate (Gate0) - 资格判定
        // ═══════════════════════════════════════════════════════════════
        const stageStart2 = Date.now();
        const eligibilityResult = runEligibilityGate({
            msg: requestContext.message,
            lang: requestContext.lang,
            history: historyBundle.sanitized,
            policyProfile: requestContext.policyProfile,
            context
        });
        audit.stages.push({
            stage: 2,
            name: 'eligibility_gate',
            latencyMs: Date.now() - stageStart2,
            output: {
                decision: eligibilityResult.decision,
                ruleId: eligibilityResult.ruleId,
                score: eligibilityResult.score
            }
        });
        audit.decisions.push({
            gate: 'eligibility',
            decision: eligibilityResult.decision,
            ruleId: eligibilityResult.ruleId,
            confidence: eligibilityResult.confidence
        });
        logger.logStage(2, 'EligibilityGate', eligibilityResult);

        // Gate0 拒绝：立即返回
        if (eligibilityResult.decision === 'REFUSE') {
            return buildRefusalResponse(eligibilityResult, audit, startTime, logger);
        }

        // ═══════════════════════════════════════════════════════════════
        // Stage 3: Deterministic Fastpaths - 确定性短路
        // ═══════════════════════════════════════════════════════════════
        const stageStart3 = Date.now();
        const fastpathResult = runDeterministicFastpaths(requestContext, historyBundle, context);
        audit.stages.push({
            stage: 3,
            name: 'deterministic_fastpaths',
            latencyMs: Date.now() - stageStart3,
            output: { triggered: fastpathResult.triggered, type: fastpathResult.type }
        });
        logger.logStage(3, 'DeterministicFastpaths', fastpathResult);

        // Fastpath 命中：立即返回
        if (fastpathResult.triggered) {
            return buildFastpathResponse(fastpathResult, audit, startTime, logger);
        }

        // ═══════════════════════════════════════════════════════════════
        // Stage 4: Semantic Resolver - 语义解析
        // ═══════════════════════════════════════════════════════════════
        const stageStart4 = Date.now();
        const semanticFrame = resolveSemantics(requestContext, historyBundle.sanitized, context);
        audit.stages.push({
            stage: 4,
            name: 'semantic_resolver',
            latencyMs: Date.now() - stageStart4,
            output: {
                dependsOnContext: semanticFrame.dependsOnContext,
                subject: semanticFrame.subject,
                slots: Object.keys(semanticFrame.slots || {})
            }
        });
        logger.logStage(4, 'SemanticResolver', semanticFrame);

        // ═══════════════════════════════════════════════════════════════
        // Stage 5: Intent Router - 意图路由
        // ═══════════════════════════════════════════════════════════════
        const stageStart5 = Date.now();
        const intentResult = await routeIntent(requestContext, semanticFrame, historyBundle.sanitized, context);
        audit.stages.push({
            stage: 5,
            name: 'intent_router',
            latencyMs: Date.now() - stageStart5,
            output: {
                intent: intentResult.intent,
                confidence: intentResult.confidence,
                clarificationNeeded: intentResult.clarificationNeeded
            }
        });
        audit.decisions.push({
            gate: 'intent',
            decision: intentResult.intent,
            confidence: intentResult.confidence,
            missingSlots: intentResult.missingSlots
        });
        logger.logStage(5, 'IntentRouter', intentResult);

        // 需要澄清：进入澄清流程
        if (intentResult.clarificationNeeded) {
            return buildClarificationResponse(intentResult, requestContext, audit, startTime, logger, context);
        }

        // ═══════════════════════════════════════════════════════════════
        // Stage 6: Context Sufficiency - 上下文充分性检查
        // ═══════════════════════════════════════════════════════════════
        const stageStart6 = Date.now();
        const sufficiencyResult = await checkContextSufficiency(
            intentResult,
            requestContext,
            semanticFrame,
            context
        );
        audit.stages.push({
            stage: 6,
            name: 'context_sufficiency',
            latencyMs: Date.now() - stageStart6,
            output: {
                sufficient: sufficiencyResult.sufficient,
                missingData: sufficiencyResult.missingData,
                canProceed: sufficiencyResult.canProceed
            }
        });
        logger.logStage(6, 'ContextSufficiency', sufficiencyResult);

        // 数据不足：返回数据缺口响应
        if (!sufficiencyResult.sufficient) {
            return buildDataGapResponse(sufficiencyResult, requestContext, audit, startTime, logger);
        }

        // ═══════════════════════════════════════════════════════════════
        // Stage 7: Execute Tools - 工具执行
        // ═══════════════════════════════════════════════════════════════
        const stageStart7 = Date.now();
        const toolOutputs = await executeTools(
            intentResult,
            requestContext,
            sufficiencyResult.availableData,
            context
        );
        audit.stages.push({
            stage: 7,
            name: 'tool_executor',
            latencyMs: Date.now() - stageStart7,
            output: {
                toolsCalled: toolOutputs.calls.map(c => c.name),
                success: toolOutputs.success
            }
        });
        audit.toolCalls = toolOutputs.calls;
        logger.logStage(7, 'ToolExecutor', { calls: toolOutputs.calls.length, success: toolOutputs.success });

        // ═══════════════════════════════════════════════════════════════
        // Stage 8: LLM Response - LLM 回复生成
        // ═══════════════════════════════════════════════════════════════
        const stageStart8 = Date.now();
        const draftReply = await generateLLMResponse(
            requestContext,
            intentResult,
            toolOutputs,
            historyBundle.sanitized,
            context
        );
        audit.stages.push({
            stage: 8,
            name: 'llm_response',
            latencyMs: Date.now() - stageStart8,
            output: {
                model: draftReply.model,
                tokenUsage: draftReply.tokenUsage,
                hasContent: !!draftReply.content
            }
        });
        audit.llmCalls.push({
            model: draftReply.model,
            tokenUsage: draftReply.tokenUsage,
            latencyMs: Date.now() - stageStart8
        });
        logger.logStage(8, 'LLMResponse', { model: draftReply.model, length: draftReply.content?.length });

        // ═══════════════════════════════════════════════════════════════
        // Stage 9: Post-LLM Safety - LLM后安全检查
        // ═══════════════════════════════════════════════════════════════
        const stageStart9 = Date.now();
        const finalReply = runPostLLMSafety(draftReply, requestContext, context);
        audit.stages.push({
            stage: 9,
            name: 'post_llm_safety',
            latencyMs: Date.now() - stageStart9,
            output: {
                modified: finalReply.modified,
                safetyFlags: finalReply.safetyFlags
            }
        });
        logger.logStage(9, 'PostLLMSafety', { modified: finalReply.modified });

        // ═══════════════════════════════════════════════════════════════
        // Stage 10: Audit + Storage - 审计与存储
        // ═══════════════════════════════════════════════════════════════
        audit.totalLatencyMs = Date.now() - startTime;
        await recordAudit(audit, requestContext, context);
        logger.logStage(10, 'Audit', { totalLatencyMs: audit.totalLatencyMs });

        // 构建最终响应
        return buildSuccessResponse(finalReply, requestContext, audit, logger);

    } catch (error) {
        logger.logError('PipelineError', error);
        audit.error = { message: error.message, stack: error.stack };
        audit.totalLatencyMs = Date.now() - startTime;
        
        // 尝试记录错误审计
        try {
            await recordAudit(audit, input, context);
        } catch (auditError) {
            logger.logError('AuditError', auditError);
        }

        return buildErrorResponse(error, audit, logger);
    }
}

// ═══════════════════════════════════════════════════════════════
// Response Builders - 响应构建器
// ═══════════════════════════════════════════════════════════════

function buildRefusalResponse(eligibilityResult, audit, startTime, logger) {
    audit.totalLatencyMs = Date.now() - startTime;
    const meta = {
        stage: 'refuse',
        ruleId: eligibilityResult.ruleId,
        confidence: eligibilityResult.confidence,
        evidence: eligibilityResult.signals || []
    };
    logger.logDecision('REFUSE', meta);

    return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
            reply: eligibilityResult.explainToUser,
            persona: 'professional',
            meta
        }),
        meta,
        audit
    };
}

function buildFastpathResponse(fastpathResult, audit, startTime, logger) {
    audit.totalLatencyMs = Date.now() - startTime;
    const meta = {
        stage: 'fastpath',
        type: fastpathResult.type,
        pattern: fastpathResult.pattern,
        confidence: 1.0,
        evidence: ['deterministic']
    };
    logger.logDecision('FASTPATH', meta);

    return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
            reply: fastpathResult.reply,
            persona: fastpathResult.persona || 'professional',
            meta
        }),
        meta,
        audit
    };
}

function buildClarificationResponse(intentResult, requestContext, audit, startTime, logger, context) {
    audit.totalLatencyMs = Date.now() - startTime;
    const meta = {
        stage: 'clarify',
        intentCandidate: intentResult.intent,
        missingSlots: intentResult.missingSlots,
        confidence: intentResult.confidence,
        evidence: ['ambiguous_input']
    };
    logger.logDecision('CLARIFY', meta);

    // 获取澄清回复
    const { buildClarificationReply } = require('../templates/replies/clarification');
    const clarifyReply = buildClarificationReply(
        intentResult,
        requestContext.lang,
        requestContext.clarificationState
    );

    return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
            reply: clarifyReply.text,
            persona: 'professional',
            meta,
            clarificationState: clarifyReply.nextState
        }),
        meta,
        audit
    };
}

function buildDataGapResponse(sufficiencyResult, requestContext, audit, startTime, logger) {
    audit.totalLatencyMs = Date.now() - startTime;
    const meta = {
        stage: 'data_gap',
        missingData: sufficiencyResult.missingData,
        confidence: 1.0,
        evidence: sufficiencyResult.checkedSources || []
    };
    logger.logDecision('DATA_GAP', meta);

    // 获取数据缺口回复
    const { buildDataGapReply } = require('../templates/replies/dataGap');
    const gapReply = buildDataGapReply(sufficiencyResult, requestContext.lang);

    return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
            reply: gapReply.text,
            persona: 'professional',
            meta,
            nextStep: gapReply.nextStep
        }),
        meta,
        audit
    };
}

function buildSuccessResponse(finalReply, requestContext, audit, logger) {
    const meta = {
        stage: 'proceed',
        confidence: finalReply.confidence || 0.9,
        evidence: finalReply.evidence || [],
        toolsUsed: audit.toolCalls.map(t => t.name),
        llmModel: audit.llmCalls[0]?.model
    };
    logger.logDecision('PROCEED', meta);

    return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
            reply: finalReply.content,
            persona: finalReply.persona || 'professional',
            meta,
            voice: finalReply.voice
        }),
        meta,
        audit
    };
}

function buildErrorResponse(error, audit, logger) {
    const meta = {
        stage: 'error',
        errorType: error.name,
        confidence: 0,
        evidence: []
    };

    return {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
            reply: '系统遇到问题，请稍后再试。',
            persona: 'professional',
            meta,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        }),
        meta,
        audit
    };
}

module.exports = {
    runDecisionPipeline
};
