/**
 * Decision Pipeline Contract 测试
 * 
 * 验证每个 Stage 的输入输出契约
 */

// ══════════════════════════════════════════════════════════════
// Contract Schemas
// ══════════════════════════════════════════════════════════════

const CONTRACTS = {
    RequestContext: {
        required: ['requestId', 'message', 'userId', 'source', 'lang', 'timestamp', 'policyProfile'],
        types: {
            requestId: 'string',
            message: 'string',
            userId: 'string',
            source: 'string',
            lang: 'string',
            timestamp: 'object',  // Date
            policyProfile: 'object'
        }
    },
    HistoryBundle: {
        required: ['raw', 'sanitized', 'filteredPatterns', 'filteredCount', 'stats'],
        types: {
            raw: 'object',  // Array
            sanitized: 'object',  // Array
            filteredPatterns: 'object',  // Array
            filteredCount: 'number',
            stats: 'object'
        }
    },
    EligibilityResult: {
        required: ['decision', 'ruleId', 'score', 'signals', 'confidence'],
        types: {
            decision: 'string',
            score: 'number',
            confidence: 'number'
        },
        validValues: {
            decision: ['PROCEED', 'REFUSE', 'DEGRADE']
        }
    },
    FastPathResult: {
        required: ['triggered'],
        types: {
            triggered: 'boolean'
        }
    },
    SemanticFrame: {
        required: ['subject', 'subjectConfidence', 'dependsOnContext', 'slots', 'missingSlots', 'standaloneSemanticValidity', 'looksLikeToolRequest'],
        types: {
            subject: 'string',
            subjectConfidence: 'number',
            dependsOnContext: 'boolean',
            slots: 'object',
            standaloneSemanticValidity: 'boolean',
            looksLikeToolRequest: 'boolean'
        }
    },
    IntentResult: {
        required: ['intent', 'confidence', 'clarificationNeeded', 'missingSlots', 'slots', 'routeMethod'],
        types: {
            intent: 'string',
            confidence: 'number',
            clarificationNeeded: 'boolean',
            routeMethod: 'string'
        }
    },
    SufficiencyResult: {
        required: ['sufficient', 'canProceed', 'missingData', 'availableData', 'checkedSources'],
        types: {
            sufficient: 'boolean',
            canProceed: 'boolean'
        }
    },
    ToolOutputs: {
        required: ['calls', 'success', 'aggregatedData'],
        types: {
            success: 'boolean'
        }
    },
    DraftReply: {
        required: ['content', 'model', 'persona', 'confidence', 'evidence'],
        types: {
            content: 'string',
            model: 'string',
            persona: 'string',
            confidence: 'number'
        }
    },
    FinalReply: {
        required: ['content', 'modified', 'safetyFlags', 'persona', 'confidence', 'evidence'],
        types: {
            content: 'string',
            modified: 'boolean',
            persona: 'string',
            confidence: 'number'
        }
    }
};

// ══════════════════════════════════════════════════════════════
// Contract Validator
// ══════════════════════════════════════════════════════════════

function validateContract(data, contractName) {
    const contract = CONTRACTS[contractName];
    if (!contract) {
        return { valid: false, errors: [`Unknown contract: ${contractName}`] };
    }
    
    const errors = [];
    
    // Check required fields
    for (const field of contract.required) {
        if (data[field] === undefined) {
            errors.push(`Missing required field: ${field}`);
        }
    }
    
    // Check types
    for (const [field, expectedType] of Object.entries(contract.types || {})) {
        if (data[field] !== undefined && data[field] !== null) {
            const actualType = typeof data[field];
            if (actualType !== expectedType) {
                errors.push(`Type mismatch for ${field}: expected ${expectedType}, got ${actualType}`);
            }
        }
    }
    
    // Check valid values
    for (const [field, validValues] of Object.entries(contract.validValues || {})) {
        if (data[field] !== undefined && data[field] !== null) {
            if (!validValues.includes(data[field])) {
                errors.push(`Invalid value for ${field}: ${data[field]}, expected one of ${validValues.join(', ')}`);
            }
        }
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

const { normalizeRequest } = require('../src/orchestrator/stages/normalize');
const { governHistory } = require('../src/orchestrator/stages/historyGovernance');
const { runEligibilityGate } = require('../src/gates/eligibilityGate');
const { runDeterministicFastpaths } = require('../src/orchestrator/stages/deterministicFastpaths');
const { resolveSemantics } = require('../src/orchestrator/stages/semanticResolver');
const { routeIntent } = require('../src/router/intentRouter');
const { checkContextSufficiency } = require('../src/orchestrator/stages/contextSufficiency');
const { executeTools } = require('../src/orchestrator/stages/toolExecutor');
const { generateLLMResponse } = require('../src/orchestrator/stages/llmResponse');
const { runPostLLMSafety } = require('../src/orchestrator/stages/postLLMSafety');

const mockContext = { log: () => {} };

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`✅ ${name}`);
    } catch (error) {
        failed++;
        console.log(`❌ ${name}`);
        console.log(`   Error: ${error.message}`);
    }
}

console.log('\n=== Contract Tests ===\n');

// Stage 0: RequestContext
test('Contract: RequestContext', () => {
    const input = { message: '你好', userId: '123' };
    const result = normalizeRequest(input, mockContext);
    const validation = validateContract(result, 'RequestContext');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

// Stage 1: HistoryBundle
test('Contract: HistoryBundle', async () => {
    const requestContext = normalizeRequest({ message: '你好', userId: '123' }, mockContext);
    const result = await governHistory(requestContext, mockContext);
    const validation = validateContract(result, 'HistoryBundle');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

// Stage 2: EligibilityResult
test('Contract: EligibilityResult - PROCEED', () => {
    const result = runEligibilityGate({ msg: '查课表', lang: 'zh', context: mockContext });
    const validation = validateContract(result, 'EligibilityResult');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

test('Contract: EligibilityResult - REFUSE', () => {
    const result = runEligibilityGate({ msg: '帮我发消息给老师', lang: 'zh', context: mockContext });
    const validation = validateContract(result, 'EligibilityResult');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

// Stage 3: FastPathResult
test('Contract: FastPathResult - triggered', () => {
    const requestContext = normalizeRequest({ message: '你好' }, mockContext);
    const result = runDeterministicFastpaths(requestContext, { sanitized: [] }, mockContext);
    const validation = validateContract(result, 'FastPathResult');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

test('Contract: FastPathResult - not triggered', () => {
    const requestContext = normalizeRequest({ message: '查课表' }, mockContext);
    const result = runDeterministicFastpaths(requestContext, { sanitized: [] }, mockContext);
    const validation = validateContract(result, 'FastPathResult');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

// Stage 4: SemanticFrame
test('Contract: SemanticFrame', () => {
    const requestContext = normalizeRequest({ message: '明天有课吗' }, mockContext);
    const result = resolveSemantics(requestContext, [], mockContext);
    const validation = validateContract(result, 'SemanticFrame');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

// Stage 5: IntentResult
test('Contract: IntentResult', async () => {
    const requestContext = normalizeRequest({ message: '查课表' }, mockContext);
    const semanticFrame = resolveSemantics(requestContext, [], mockContext);
    const result = await routeIntent(requestContext, semanticFrame, [], mockContext);
    const validation = validateContract(result, 'IntentResult');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

// Stage 6: SufficiencyResult
test('Contract: SufficiencyResult', async () => {
    const requestContext = normalizeRequest({ message: '查课表' }, mockContext);
    const semanticFrame = resolveSemantics(requestContext, [], mockContext);
    const intentResult = await routeIntent(requestContext, semanticFrame, [], mockContext);
    const result = await checkContextSufficiency(intentResult, requestContext, semanticFrame, mockContext);
    const validation = validateContract(result, 'SufficiencyResult');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

// Stage 7: ToolOutputs
test('Contract: ToolOutputs', async () => {
    const requestContext = normalizeRequest({ message: '查天气' }, mockContext);
    const semanticFrame = resolveSemantics(requestContext, [], mockContext);
    const intentResult = await routeIntent(requestContext, semanticFrame, [], mockContext);
    const result = await executeTools(intentResult, requestContext, {}, mockContext);
    const validation = validateContract(result, 'ToolOutputs');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

// Stage 8: DraftReply
test('Contract: DraftReply', async () => {
    const requestContext = normalizeRequest({ message: '你好' }, mockContext);
    const semanticFrame = resolveSemantics(requestContext, [], mockContext);
    const intentResult = await routeIntent(requestContext, semanticFrame, [], mockContext);
    const toolOutputs = { calls: [], success: true, aggregatedData: {} };
    const result = await generateLLMResponse(requestContext, intentResult, toolOutputs, [], mockContext);
    const validation = validateContract(result, 'DraftReply');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

// Stage 9: FinalReply
test('Contract: FinalReply', async () => {
    const draftReply = {
        content: '这是测试回复',
        model: 'test',
        tokenUsage: {},
        persona: 'professional',
        confidence: 0.9,
        evidence: []
    };
    const requestContext = normalizeRequest({ message: '你好' }, mockContext);
    const result = runPostLLMSafety(draftReply, requestContext, mockContext);
    const validation = validateContract(result, 'FinalReply');
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
});

// ══════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(50));
console.log(`契约测试结果: ${passed}/${passed + failed} 通过`);
console.log('═'.repeat(50));

if (failed > 0) {
    process.exit(1);
}
