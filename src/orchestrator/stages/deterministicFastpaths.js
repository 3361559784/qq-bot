/**
 * Stage 3: Deterministic Fastpaths - 确定性短路
 * 
 * 职责：
 * - greeting / smalltalk / ping / healthcheck / identity
 * - 确定性短路，不调用 LLM
 * 
 * 输出：FastPathResult
 */

/**
 * Fastpath 类型配置
 */
const FASTPATH_CONFIGS = {
    // ══════════════════════════════════════════════════════════════
    // 问候语
    // ══════════════════════════════════════════════════════════════
    greeting: {
        patterns: {
            zh: /^(你好|您好|嗨|哈喽|在吗|早上好|晚上好|晚安|早安|中午好|下午好)[!！。\.\s]*$/i,
            en: /^(hi|hello|hey|good\s+(morning|afternoon|evening|night))[\s!.]*$/i,
            ja: /^(こんにちは|こんばんは|おはよう|やあ|ハロー)[！!。\.\s]*$/i
        },
        replies: {
            zh: {
                morning: '早上好！今天想做什么？查课表/做学习计划/查天气，直接说就行。',
                forenoon: '你好，我在。需要查课表、做计划还是其他？',
                noon: '中午好！需要我帮你做什么？',
                afternoon: '下午好！有什么可以帮你的？',
                evening: '晚上好！需要查询什么吗？',
                night: '这么晚了还在忙？需要我帮你做什么？',
                default: '你好，我在。你想查课表/做学习规划/看天气/问项目问题，直接说一句就行。'
            },
            en: {
                morning: "Good morning! What would you like to do today? Check schedule / plan study time / check weather — just say it.",
                forenoon: "Hi, I'm here. Need to check your schedule, make a plan, or something else?",
                noon: "Good afternoon! What can I help you with?",
                afternoon: "Good afternoon! How can I help?",
                evening: "Good evening! What would you like to check?",
                night: "Working late? What can I help you with?",
                default: "Hi, I'm here. Tell me what you need — check your schedule, plan study time, check weather, or ask about the project — just say it in one line."
            },
            ja: {
                morning: 'おはようございます！今日は何をしますか？時間割確認/学習計画/天気確認、言ってください。',
                default: 'こんにちは。時間割確認/学習計画/天気確認、何でも言ってください。'
            }
        },
        persona: 'professional'
    },
    
    // ══════════════════════════════════════════════════════════════
    // 身份询问
    // ══════════════════════════════════════════════════════════════
    identity: {
        patterns: {
            zh: /^(你是谁|你叫什么|介绍一下自己|你是什么|你是AI吗)[？\?\s]*$/i,
            en: /^(who\s+are\s+you|what\s+are\s+you|introduce\s+yourself|are\s+you\s+(an?\s+)?ai)[?\s]*$/i,
            ja: /^(あなたは誰|自己紹介して|何ですか)[？\?\s]*$/i
        },
        replies: {
            zh: {
                default: '我是校园 AI 助手 Aris (Campus Copilot)，专注于帮你整合校园碎片化信息。\n\n核心能力：\n• 课表查询与空档分析\n• 学习任务规划\n• 天气查询\n• 信息搜索\n\n需要我帮你做什么？'
            },
            en: {
                default: "I'm Aris (Campus Copilot), an AI assistant focused on integrating fragmented campus information.\n\nCore capabilities:\n• Schedule queries & free time analysis\n• Study task planning\n• Weather queries\n• Information search\n\nWhat can I help you with?"
            },
            ja: {
                default: '私はキャンパスAIアシスタントのAris（Campus Copilot）です。キャンパス情報の統合をサポートします。\n\n主な機能：\n• 時間割確認と空き時間分析\n• 学習計画\n• 天気確認\n• 情報検索\n\n何かお手伝いしましょうか？'
            }
        },
        persona: 'professional'
    },
    
    // ══════════════════════════════════════════════════════════════
    // 健康检查 / Ping
    // ══════════════════════════════════════════════════════════════
    ping: {
        patterns: {
            zh: /^(ping|pong|测试|test|在不在|能听到吗)[？\?\s]*$/i,
            en: /^(ping|pong|test|are\s+you\s+there|can\s+you\s+hear\s+me)[?\s]*$/i
        },
        replies: {
            zh: { default: 'pong! 系统正常运行中。' },
            en: { default: 'pong! System is running normally.' }
        },
        persona: 'professional'
    },
    
    // ══════════════════════════════════════════════════════════════
    // 感谢
    // ══════════════════════════════════════════════════════════════
    thanks: {
        patterns: {
            zh: /^(谢谢|感谢|多谢|thx|thanks|ty)[！!\s]*$/i,
            en: /^(thanks?|thank\s+you|thx|ty)[!\s]*$/i
        },
        replies: {
            zh: { default: '不客气！还有其他需要帮忙的吗？' },
            en: { default: "You're welcome! Anything else I can help with?" }
        },
        persona: 'professional'
    },
    
    // ══════════════════════════════════════════════════════════════
    // 告别
    // ══════════════════════════════════════════════════════════════
    farewell: {
        patterns: {
            zh: /^(再见|拜拜|bye|晚安|回见|下次见)[！!\s]*$/i,
            en: /^(bye|goodbye|see\s+you|good\s+night|later)[!\s]*$/i
        },
        replies: {
            zh: { default: '再见！有需要随时找我。' },
            en: { default: 'Goodbye! Feel free to reach out anytime.' }
        },
        persona: 'professional'
    }
};

/**
 * @typedef {Object} FastPathResult
 * @property {boolean} triggered - 是否触发快路
 * @property {string|null} type - 快路类型
 * @property {string|null} pattern - 匹配的模式
 * @property {string|null} reply - 回复内容
 * @property {string} persona - 角色
 */

/**
 * 检测并执行确定性快路
 * @param {Object} requestContext - 标准化后的请求上下文
 * @param {Object} historyBundle - 历史记录包
 * @param {Object} context - Azure Functions context
 * @returns {FastPathResult}
 */
function runDeterministicFastpaths(requestContext, historyBundle, context) {
    const { message, lang, timeOfDay } = requestContext;
    
    // 遍历所有快路配置
    for (const [type, config] of Object.entries(FASTPATH_CONFIGS)) {
        const patterns = config.patterns[lang] || config.patterns['zh'] || [];
        const pattern = Array.isArray(patterns) ? patterns : [patterns];
        
        for (const p of (pattern instanceof RegExp ? [pattern] : pattern)) {
            if (p.test(message)) {
                // 获取回复
                const replies = config.replies[lang] || config.replies['zh'];
                const reply = replies[timeOfDay] || replies.default;
                
                context?.log?.(`[Stage3] Fastpath triggered: type=${type} pattern=${p.toString()}`);
                
                return {
                    triggered: true,
                    type,
                    pattern: p.toString(),
                    reply,
                    persona: config.persona || 'professional'
                };
            }
        }
    }
    
    // 没有匹配任何快路
    return {
        triggered: false,
        type: null,
        pattern: null,
        reply: null,
        persona: 'professional'
    };
}

/**
 * 检测是否为纯问候（用于外部调用）
 * @param {string} text 
 * @returns {{ detected: boolean, lang: string|null }}
 */
function detectGreeting(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { detected: false, lang: null };
    
    const greetingConfig = FASTPATH_CONFIGS.greeting;
    for (const [lang, pattern] of Object.entries(greetingConfig.patterns)) {
        if (pattern.test(trimmed)) {
            return { detected: true, lang };
        }
    }
    
    return { detected: false, lang: null };
}

module.exports = {
    runDeterministicFastpaths,
    detectGreeting,
    FASTPATH_CONFIGS
};
