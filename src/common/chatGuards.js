const GREETING_PATTERNS = {
    zh: /^(你好|您好|嗨|哈喽|在吗|早上好|晚上好|晚安)[!！。\.\s]*$/i,
    en: /^(hi|hello|hey|good\s+(morning|afternoon|evening))[\s!.]*$/i
};

const REFUSAL_POLLUTION_PATTERNS = /(无法判断|请提供相关信息|请求不够明确|请选择(?:课表|天气|搜索))/i;

function detectGreetingFastPath(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (GREETING_PATTERNS.zh.test(trimmed)) return { lang: 'zh', pattern: 'zh_greeting' };
    if (GREETING_PATTERNS.en.test(trimmed)) return { lang: 'en', pattern: 'en_greeting' };
    return null;
}

function buildGreetingFastPathReply(lang = 'zh') {
    const replyMap = {
        zh: '你好，我在。你想查课表/做学习规划/看天气/问项目问题，直接说一句就行。',
        en: "Hi, I'm here. Tell me what you need — check your schedule, plan study time, check weather, or ask about the project — just say it in one line."
    };
    const key = lang === 'en' ? 'en' : 'zh';
    const pattern = key === 'en' ? 'en_greeting' : 'zh_greeting';
    return {
        reply: replyMap[key],
        persona: 'professional',
        meta: { stage: 'greeting_fast_path', lang: key, pattern }
    };
}

function sanitizeHistoryForInference(history = []) {
    if (!Array.isArray(history)) return [];
    return history.filter(entry => {
        if (!entry || typeof entry.content !== 'string') return false;
        if (entry.role === 'assistant' && REFUSAL_POLLUTION_PATTERNS.test(entry.content)) return false;
        return entry.role === 'user' || entry.role === 'assistant';
    });
}

module.exports = {
    detectGreetingFastPath,
    buildGreetingFastPathReply,
    sanitizeHistoryForInference,
    GREETING_PATTERNS,
    REFUSAL_POLLUTION_PATTERNS
};
