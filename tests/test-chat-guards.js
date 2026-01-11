const { detectGreetingFastPath, buildGreetingFastPathReply, sanitizeHistoryForInference } = require('../src/common/chatGuards');

console.log('=== Greeting Fast-Path 测试 ===');

const greetingCases = [
    { msg: '你好', expectHit: true, lang: 'zh' },
    { msg: 'hi', expectHit: true, lang: 'en' },
    { msg: 'v我50', expectHit: false },
    { msg: 'Help me plan next week', expectHit: false }
];

let passed = 0;
let failed = 0;

greetingCases.forEach((tc, idx) => {
    const hit = detectGreetingFastPath(tc.msg);
    const ok = (!!hit) === tc.expectHit && (!hit || hit.lang === tc.lang);
    if (ok) {
        passed++;
        const reply = hit ? buildGreetingFastPathReply(hit.lang).reply : '(no fast-path)';
        console.log(`✅ #${idx + 1} 输入: "${tc.msg}" → ${hit ? '命中' : '未命中'} ${hit ? `lang=${hit.lang}` : ''}`);
        if (hit) console.log(`   预设回复: ${reply}`);
    } else {
        failed++;
        console.log(`❌ #${idx + 1} 输入: "${tc.msg}" → 期望 ${tc.expectHit ? '命中' : '未命中'}`);
    }
});

console.log('\n=== 历史过滤测试 ===');
const pollutedHistory = [
    { role: 'user', content: '查课表' },
    { role: 'assistant', content: '无法判断。请提供相关信息后再查询。' },
    { role: 'assistant', content: '好的，我在。' },
];
const cleaned = sanitizeHistoryForInference(pollutedHistory);
const removedPollution = cleaned.length === 2 && !cleaned.some(h => /无法判断/.test(h.content));
if (removedPollution) {
    passed++;
    console.log('✅ 拒绝模板已从历史中过滤');
} else {
    failed++;
    console.log('❌ 拒绝模板未被过滤');
}

console.log(`\n=== 结果: ${passed}/${greetingCases.length + 1} 通过 ===`);
if (failed > 0) {
    process.exitCode = 1;
}
