/**
 * EligibilityGate 测试脚本
 * 用法：node tests/test-eligibility-gate.js
 */
const { runEligibilityGate, checkEligibilityBypass, EligibilityAction, EligibilityType } = require('../src/common/eligibilityGate');

// 测试用例
const testCases = [
    { msg: '帮我决定要不要去上课', expected: 'refuse', desc: '明确代决策' },
    { msg: '我应该选哪个专业', expected: 'refuse', desc: '应该+选择' },
    { msg: '今天有什么课', expected: 'proceed', desc: '普通查询' },
    { msg: '为什么应该用微服务', expected: 'proceed', desc: '技术讨论（含"应该"但负信号抵消）' },
    { msg: '帮我查一下明天的天气', expected: 'proceed', desc: '信息查询（含"帮我"但有"查"负信号）' },
    { msg: '帮我退课', expected: 'refuse', desc: '代行动' },
    { msg: '帮我给老师发个邮件请假', expected: 'refuse', desc: '高风险代行' },
    { msg: 'should i go to class tomorrow', expected: 'refuse', desc: '英文代决策' },
    { msg: 'what time is my class', expected: 'proceed', desc: '英文普通查询' },
    { msg: '明天几点有课', expected: 'proceed', desc: '时间查询' },
    { msg: '这门课值不值得选', expected: 'degrade', desc: '值不值得（边界，降级）' },
    { msg: '微积分这门课难不难', expected: 'proceed', desc: '信息询问（非决策）' },
];

console.log('=== EligibilityGate 测试 ===\n');

let passed = 0;
let failed = 0;

testCases.forEach((tc, i) => {
    const result = runEligibilityGate({ msg: tc.msg, lang: 'zh', policyProfile: null, context: null });
    const actual = result.action;
    const ok = actual === tc.expected;
    
    if (ok) {
        passed++;
        console.log(`✅ #${i+1} ${tc.desc}`);
        console.log(`   输入: "${tc.msg}"`);
        console.log(`   结果: ${actual} (score: ${result.checkResult?.score?.toFixed(3) || 'N/A'})`);
    } else {
        failed++;
        console.log(`❌ #${i+1} ${tc.desc}`);
        console.log(`   输入: "${tc.msg}"`);
        console.log(`   期望: ${tc.expected}, 实际: ${actual} (score: ${result.checkResult?.score?.toFixed(3) || 'N/A'})`);
        console.log(`   匹配信号: ${JSON.stringify(result.checkResult?.matchedSignals?.slice(0,5))}`);
    }
    console.log('');
});

console.log(`=== 结果: ${passed}/${testCases.length} 通过 ===`);

if (failed > 0) {
    console.log('\n注意：部分测试失败可能需要调整信号权重或添加新的负信号模式。');
}
