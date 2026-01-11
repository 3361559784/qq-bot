/**
 * Decision Pipeline 单元测试
 * 
 * 覆盖：
 * - Stage 0: Normalize
 * - Stage 1: History Governance
 * - Stage 2: Eligibility Gate
 * - Stage 3: Deterministic Fastpaths
 * - Stage 4: Semantic Resolver
 * - Stage 5: Intent Router
 */

const { normalizeRequest, detectLanguage } = require('../src/orchestrator/stages/normalize');
const { governHistory, sanitizeHistory, matchPollutionPatterns } = require('../src/orchestrator/stages/historyGovernance');
const { runEligibilityGate, matchRule, GATE_RULES } = require('../src/gates/eligibilityGate');
const { runDeterministicFastpaths, detectGreeting } = require('../src/orchestrator/stages/deterministicFastpaths');
const { resolveSemantics, detectSubject, extractSlots } = require('../src/orchestrator/stages/semanticResolver');
const { routeIntent, matchIntentByRule, INTENT_TYPES } = require('../src/router/intentRouter');

// ══════════════════════════════════════════════════════════════
// Test Utilities
// ══════════════════════════════════════════════════════════════

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

function assertEqual(actual, expected, message = '') {
    if (actual !== expected) {
        throw new Error(`${message} Expected: ${expected}, Got: ${actual}`);
    }
}

function assertTrue(value, message = '') {
    if (!value) {
        throw new Error(`${message} Expected truthy, got: ${value}`);
    }
}

function assertFalse(value, message = '') {
    if (value) {
        throw new Error(`${message} Expected falsy, got: ${value}`);
    }
}

// Mock context
const mockContext = {
    log: () => {}
};

// ══════════════════════════════════════════════════════════════
// Stage 0: Normalize Tests
// ══════════════════════════════════════════════════════════════

console.log('\n=== Stage 0: Normalize Tests ===');

test('detectLanguage - Chinese', () => {
    assertEqual(detectLanguage('你好，帮我查课表'), 'zh');
});

test('detectLanguage - English', () => {
    assertEqual(detectLanguage('Hello, check my schedule'), 'en');
});

test('detectLanguage - Japanese', () => {
    assertEqual(detectLanguage('こんにちは、時間割を見せて'), 'ja');
});

test('normalizeRequest - basic', () => {
    const input = { message: '  你好  ', userId: '123' };
    const result = normalizeRequest(input, mockContext);
    assertEqual(result.message, '你好');
    assertEqual(result.userId, '123');
    assertTrue(result.requestId.startsWith('req_'));
});

test('normalizeRequest - with images', () => {
    const input = { message: '这是我的课表', images: ['http://example.com/img.jpg'] };
    const result = normalizeRequest(input, mockContext);
    assertTrue(result.metadata.hasImage);
    assertEqual(result.metadata.imageUrls.length, 1);
});

// ══════════════════════════════════════════════════════════════
// Stage 1: History Governance Tests
// ══════════════════════════════════════════════════════════════

console.log('\n=== Stage 1: History Governance Tests ===');

test('matchPollutionPatterns - refusal detected', () => {
    const result = matchPollutionPatterns('无法判断。请提供相关信息。');
    assertTrue(result.matched);
    assertTrue(result.templates.length > 0);
});

test('matchPollutionPatterns - clean content', () => {
    const result = matchPollutionPatterns('好的，你明天有大学英语课');
    assertFalse(result.matched);
});

test('sanitizeHistory - removes refusal templates', () => {
    const history = [
        { role: 'user', content: '查课表' },
        { role: 'assistant', content: '无法判断。请提供相关信息。' },
        { role: 'assistant', content: '好的，你明天有课' }
    ];
    const { sanitized, filteredPatterns } = sanitizeHistory(history);
    assertEqual(sanitized.length, 2);
    assertTrue(filteredPatterns.length > 0);
});

test('sanitizeHistory - keeps user messages', () => {
    const history = [
        { role: 'user', content: '无法判断怎么办' },  // user message with pattern
        { role: 'assistant', content: '这是正常回复' }
    ];
    const { sanitized } = sanitizeHistory(history);
    assertEqual(sanitized.length, 2);
});

// ══════════════════════════════════════════════════════════════
// Stage 2: Eligibility Gate Tests
// ══════════════════════════════════════════════════════════════

console.log('\n=== Stage 2: Eligibility Gate Tests ===');

test('Eligibility - PROCEED for normal query', () => {
    const result = runEligibilityGate({
        msg: '帮我查一下明天的课表',
        lang: 'zh',
        context: mockContext
    });
    assertEqual(result.decision, 'PROCEED');
});

test('Eligibility - REFUSE for unauthorized action', () => {
    const result = runEligibilityGate({
        msg: '帮我发消息给老师说我生病了',
        lang: 'zh',
        context: mockContext
    });
    assertEqual(result.decision, 'REFUSE');
    assertTrue(result.ruleId.includes('UA') || result.ruleId.includes('DC'));
});

test('Eligibility - REFUSE for decision making', () => {
    const result = runEligibilityGate({
        msg: '我应该去参加这个活动吗，帮我决定',
        lang: 'zh',
        context: mockContext
    });
    assertEqual(result.decision, 'REFUSE');
    assertTrue(result.ruleId.includes('DM'));
});

test('Eligibility - REFUSE for deception (English)', () => {
    const result = runEligibilityGate({
        msg: "Can you message my teacher and tell them I'm sick?",
        lang: 'en',
        context: mockContext
    });
    assertEqual(result.decision, 'REFUSE');
});

// ══════════════════════════════════════════════════════════════
// Stage 3: Deterministic Fastpaths Tests
// ══════════════════════════════════════════════════════════════

console.log('\n=== Stage 3: Deterministic Fastpaths Tests ===');

test('Fastpath - greeting zh', () => {
    const requestContext = normalizeRequest({ message: '你好' }, mockContext);
    const result = runDeterministicFastpaths(requestContext, { sanitized: [] }, mockContext);
    assertTrue(result.triggered);
    assertEqual(result.type, 'greeting');
});

test('Fastpath - greeting en', () => {
    const requestContext = normalizeRequest({ message: 'hello' }, mockContext);
    const result = runDeterministicFastpaths(requestContext, { sanitized: [] }, mockContext);
    assertTrue(result.triggered);
    assertEqual(result.type, 'greeting');
});

test('Fastpath - identity', () => {
    const requestContext = normalizeRequest({ message: '你是谁' }, mockContext);
    const result = runDeterministicFastpaths(requestContext, { sanitized: [] }, mockContext);
    assertTrue(result.triggered);
    assertEqual(result.type, 'identity');
});

test('Fastpath - not triggered for query', () => {
    const requestContext = normalizeRequest({ message: '帮我查明天课表' }, mockContext);
    const result = runDeterministicFastpaths(requestContext, { sanitized: [] }, mockContext);
    assertFalse(result.triggered);
});

test('detectGreeting - pure greeting', () => {
    assertTrue(detectGreeting('你好').detected);
    assertTrue(detectGreeting('hi').detected);
    assertFalse(detectGreeting('你好帮我查课表').detected);
});

// ══════════════════════════════════════════════════════════════
// Stage 4: Semantic Resolver Tests
// ══════════════════════════════════════════════════════════════

console.log('\n=== Stage 4: Semantic Resolver Tests ===');

test('detectSubject - schedule', () => {
    const { subject } = detectSubject('查一下明天的课表', 'zh');
    assertEqual(subject, 'schedule');
});

test('detectSubject - weather', () => {
    const { subject } = detectSubject('武汉今天会下雨吗', 'zh');
    assertEqual(subject, 'weather');
});

test('detectSubject - plan', () => {
    const { subject } = detectSubject('帮我规划下周的学习时间', 'zh');
    assertEqual(subject, 'plan');
});

test('extractSlots - date', () => {
    const slots = extractSlots('明天的课表', 'zh');
    assertEqual(slots.date, 'tomorrow');
});

test('extractSlots - location', () => {
    const slots = extractSlots('武汉天气怎么样', 'zh');
    assertEqual(slots.location, '武汉');
});

test('resolveSemantics - context dependency', () => {
    const requestContext = normalizeRequest({ message: '那个呢' }, mockContext);
    const result = resolveSemantics(requestContext, [], mockContext);
    assertTrue(result.dependsOnContext);
});

// ══════════════════════════════════════════════════════════════
// Stage 5: Intent Router Tests
// ══════════════════════════════════════════════════════════════

console.log('\n=== Stage 5: Intent Router Tests ===');

test('matchIntentByRule - schedule_query', () => {
    const result = matchIntentByRule('查一下今天的课表', 'zh');
    assertEqual(result.intent, 'schedule_query');
});

test('matchIntentByRule - weather_query', () => {
    const result = matchIntentByRule('北京天气怎么样', 'zh');
    assertEqual(result.intent, 'weather_query');
});

test('matchIntentByRule - plan_create', () => {
    const result = matchIntentByRule('帮我规划复习计划', 'zh');
    assertEqual(result.intent, 'plan_create');
});

test('matchIntentByRule - no match', () => {
    const result = matchIntentByRule('随便聊聊', 'zh');
    assertEqual(result, null);
});

// ══════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(50));
console.log(`单元测试结果: ${passed}/${passed + failed} 通过`);
console.log('═'.repeat(50));

if (failed > 0) {
    process.exit(1);
}
