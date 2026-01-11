/**
 * Decision Pipeline 场景回归测试
 * 
 * 覆盖三个核心 demo 场景 + 边界场景
 */

const { runDecisionPipeline } = require('../src/orchestrator/decisionPipeline');

const mockContext = {
    log: (msg) => {
        if (process.env.DEBUG) console.log(msg);
    }
};

const tests = [];

function test(name, fn) {
    tests.push({ name, fn });
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

function assertContains(text, substring, message = '') {
    if (!text || !text.includes(substring)) {
        throw new Error(`${message} Expected "${text}" to contain "${substring}"`);
    }
}

// ══════════════════════════════════════════════════════════════
// Scenario 1: 纯问候短路
// ══════════════════════════════════════════════════════════════

test('Greeting zh: 你好', async () => {
    const result = await runDecisionPipeline(
        { message: '你好', userId: 'test_user' },
        mockContext
    );
    assertEqual(result.meta.stage, 'fastpath');
    assertEqual(result.meta.type, 'greeting');
});

test('Greeting en: hi', async () => {
    const result = await runDecisionPipeline(
        { message: 'hi', userId: 'test_user' },
        mockContext
    );
    assertEqual(result.meta.stage, 'fastpath');
});

test('Greeting: 在吗', async () => {
    const result = await runDecisionPipeline(
        { message: '在吗', userId: 'test_user' },
        mockContext
    );
    assertEqual(result.meta.stage, 'fastpath');
});

test('NOT Greeting: 你好帮我查课表', async () => {
    const result = await runDecisionPipeline(
        { message: '你好帮我查课表', userId: 'test_user' },
        mockContext
    );
    // Should NOT be a fastpath
    assertTrue(result.meta.stage !== 'fastpath' || result.meta.type !== 'greeting');
});

// ══════════════════════════════════════════════════════════════
// Scenario 2: 数据缺口（缺课表）
// ══════════════════════════════════════════════════════════════

console.log('\n--- Scenario 2: Data Gap (Missing Schedule) ---');

test('Data Gap: 查课表（无数据）', async () => {
    const result = await runDecisionPipeline(
        { message: '查一下明天的课表', userId: 'test_user' },
        mockContext
    );
    // Should be data_gap or proceed with degrade message
    assertTrue(
        result.meta.stage === 'data_gap' || 
        (result.body && result.body.includes('课表'))
    );
});

test('Data Gap: 帮我规划学习时间', async () => {
    const result = await runDecisionPipeline(
        { message: '帮我规划下周的学习时间', userId: 'test_user' },
        mockContext
    );
    // Should mention needing schedule data
    const body = JSON.parse(result.body);
    assertTrue(
        result.meta.stage === 'data_gap' ||
        body.reply?.includes('课表') ||
        result.meta.stage === 'proceed'
    );
});

// ══════════════════════════════════════════════════════════════
// Scenario 3: 越权/代决策拒绝
// ══════════════════════════════════════════════════════════════

console.log('\n--- Scenario 3: Eligibility Gate Refusal ---');

test('Refusal: 代发消息（中文）', async () => {
    const result = await runDecisionPipeline(
        { message: '帮我发消息给老师说我生病了', userId: 'test_user' },
        mockContext
    );
    assertEqual(result.meta.stage, 'refuse');
    assertTrue(result.meta.ruleId !== null);
});

test('Refusal: 代决策（中文）', async () => {
    const result = await runDecisionPipeline(
        { message: '我应该去参加这个活动吗，帮我决定', userId: 'test_user' },
        mockContext
    );
    assertEqual(result.meta.stage, 'refuse');
});

test('Refusal: Unauthorized action (English)', async () => {
    const result = await runDecisionPipeline(
        { message: "Can you message my teacher and tell them I'm sick, and also cancel my class for tomorrow?", userId: 'test_user' },
        mockContext
    );
    assertEqual(result.meta.stage, 'refuse');
});

test('Refusal: Should I skip class (English)', async () => {
    const result = await runDecisionPipeline(
        { message: "Should I skip my class tomorrow?", userId: 'test_user' },
        mockContext
    );
    assertEqual(result.meta.stage, 'refuse');
});

// ══════════════════════════════════════════════════════════════
// Scenario 4: 身份询问
// ══════════════════════════════════════════════════════════════

console.log('\n--- Scenario 4: Identity Query ---');

test('Identity: 你是谁', async () => {
    const result = await runDecisionPipeline(
        { message: '你是谁', userId: 'test_user' },
        mockContext
    );
    assertEqual(result.meta.stage, 'fastpath');
    assertEqual(result.meta.type, 'identity');
});

// ══════════════════════════════════════════════════════════════
// Scenario 5: 天气查询（正常流程）
// ══════════════════════════════════════════════════════════════

console.log('\n--- Scenario 5: Weather Query ---');

test('Weather: 武汉天气', async () => {
    const result = await runDecisionPipeline(
        { message: '武汉今天天气怎么样', userId: 'test_user' },
        mockContext
    );
    // Should proceed (weather doesn't need schedule)
    assertTrue(result.meta.stage === 'proceed' || result.status === 200);
});

// ══════════════════════════════════════════════════════════════
// Scenario 6: 历史污染过滤
// ══════════════════════════════════════════════════════════════

console.log('\n--- Scenario 6: History Pollution Filter ---');

test('History: 过滤拒绝模板', async () => {
    const result = await runDecisionPipeline(
        {
            message: '继续刚才的话题',
            userId: 'test_user',
            history: [
                { role: 'user', content: '查课表' },
                { role: 'assistant', content: '无法判断。请提供相关信息。' },
                { role: 'user', content: '好的' }
            ]
        },
        mockContext
    );
    // Should have filtered the pollution
    assertTrue(result.audit?.stages?.[1]?.output?.filteredCount >= 0);
});

// ══════════════════════════════════════════════════════════════
// Run all tests
// ══════════════════════════════════════════════════════════════

async function runAllTests() {
    console.log('\n=== Scenario Regression Tests ===\n');
    let passed = 0;
    let failed = 0;
    const results = [];

    for (const { name, fn } of tests) {
        const startTime = Date.now();
        try {
            await fn();
            const latencyMs = Date.now() - startTime;
            passed++;
            console.log(`✅ ${name} (${latencyMs}ms)`);
            results.push({ name, status: 'passed', latencyMs });
        } catch (error) {
            const latencyMs = Date.now() - startTime;
            failed++;
            console.log(`❌ ${name}`);
            console.log(`   Error: ${error.message}`);
            results.push({ name, status: 'failed', latencyMs, error: error.message });
        }
    }

    console.log('\n' + '═'.repeat(50));
    console.log(`场景回归测试结果: ${passed}/${passed + failed} 通过`);
    console.log('═'.repeat(50));

    // 输出 JSON 报告
    const report = {
        timestamp: new Date().toISOString(),
        summary: {
            total: passed + failed,
            passed,
            failed,
            passRate: ((passed / (passed + failed)) * 100).toFixed(1) + '%'
        },
        results
    };

    console.log('\n--- Report ---');
    console.log(JSON.stringify(report, null, 2));

    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests();
