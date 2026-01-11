/**
 * Eligibility Gate (Gate0) - 资格判定门
 * 
 * 职责：
 * - 在任何 LLM 调用前拦截不合规请求
 * - 结构化输出：decision, ruleId, scores, signals, explainToUser
 * 
 * 判定类型：
 * - PROCEED: 继续处理
 * - REFUSE: 立即拒绝（高风险/越权）
 * - DEGRADE: 降级处理（灰度/限流）
 */

/**
 * Gate 规则配置
 */
const GATE_RULES = {
    // ══════════════════════════════════════════════════════════════
    // 越权/代操作类
    // ══════════════════════════════════════════════════════════════
    'EG0-UA-01': {
        id: 'EG0-UA-01',
        name: 'unauthorized_action',
        description: '检测代操作请求',
        patterns: {
            zh: [
                /帮我(发|发送|转发)(消息|信息|邮件)/,
                /帮我(打电话|联系|通知)/,
                /替我(请假|取消|报名|预约)/,
                /以我的名义/
            ],
            en: [
                /send\s+(a\s+)?(message|email|text)\s+(to|for)\s+me/i,
                /message\s+(my\s+)?(teacher|professor|boss)/i,
                /cancel\s+(my\s+)?(class|meeting|appointment)/i,
                /on\s+my\s+behalf/i
            ]
        },
        score: 0.85,
        decision: 'REFUSE',
        refusalKey: 'unauthorized_action'
    },
    
    // ══════════════════════════════════════════════════════════════
    // 代决策类
    // ══════════════════════════════════════════════════════════════
    'EG0-DM-01': {
        id: 'EG0-DM-01',
        name: 'decision_making',
        description: '检测代决策请求',
        patterns: {
            zh: [
                /帮我(决定|选择|拿主意)/,
                /(应该|该不该|要不要)(去|参加|报名|选)/,
                /替我(做决定|拍板|决策)/,
                /你觉得我(应该|该)/
            ],
            en: [
                /should\s+i\s+(go|take|choose|attend|skip)/i,
                /(decide|choose)\s+for\s+me/i,
                /help\s+me\s+decide/i,
                /what\s+should\s+i\s+do/i
            ]
        },
        score: 0.70,
        decision: 'REFUSE',
        refusalKey: 'decision_making'
    },
    
    // ══════════════════════════════════════════════════════════════
    // 高风险欺骗类
    // ══════════════════════════════════════════════════════════════
    'EG0-DC-01': {
        id: 'EG0-DC-01',
        name: 'deception_request',
        description: '检测欺骗性请求',
        patterns: {
            zh: [
                /帮我(编|写|想).*(借口|理由|谎话)/,
                /(撒谎|骗人|欺骗)/,
                /假装.*(生病|有事|不在)/
            ],
            en: [
                /(make\s+up|create|write)\s+(an?\s+)?(excuse|lie)/i,
                /tell\s+(them|my\s+\w+)\s+(that\s+)?i('m|\s+am)\s+sick/i,
                /pretend\s+(to\s+be|i('m|\s+am))/i
            ]
        },
        score: 0.90,
        decision: 'REFUSE',
        refusalKey: 'deception'
    },
    
    // ══════════════════════════════════════════════════════════════
    // 安全类
    // ══════════════════════════════════════════════════════════════
    'EG0-SF-01': {
        id: 'EG0-SF-01',
        name: 'safety_harmful',
        description: '检测有害内容请求',
        patterns: {
            zh: [
                /(自杀|自残|自我伤害)/,
                /(伤害|打|杀)(别人|他人|某人)/,
                /(制作|制造).*(武器|炸弹|毒品)/
            ],
            en: [
                /(hurt|harm|kill)\s+(myself|others|someone)/i,
                /(make|create|build)\s+(a\s+)?(weapon|bomb|drug)/i,
                /suicide|self[- ]harm/i
            ]
        },
        score: 0.95,
        decision: 'REFUSE',
        refusalKey: 'safety_harmful'
    },
    
    // ══════════════════════════════════════════════════════════════
    // 降级类（非拒绝，但需要特殊处理）
    // ══════════════════════════════════════════════════════════════
    'EG0-DG-01': {
        id: 'EG0-DG-01',
        name: 'low_confidence_context',
        description: '上下文不足导致低置信度',
        patterns: {
            zh: [/(这个|那个|它|他们)怎么样/],
            en: [/\b(it|this|that|they)\b.*\?$/i]
        },
        score: 0.40,
        decision: 'DEGRADE',
        refusalKey: null
    }
};

/**
 * 拒绝回复模板
 */
const REFUSAL_TEMPLATES = {
    // ══════════════════════════════════════════════════════════════
    // 越权/代操作
    // ══════════════════════════════════════════════════════════════
    unauthorized_action: {
        zh: {
            explainToUser: '我不能代你执行这个操作（发消息/请假/取消预约等）——这需要你本人确认。',
            alternative: '不过我可以帮你：\n• 起草消息内容（你自己发送）\n• 提供操作步骤指引\n• 查询相关政策或截止日期',
            nextStep: '需要我帮你起草一份消息吗？'
        },
        en: {
            explainToUser: "I can't perform this action on your behalf (sending messages, requesting leave, canceling appointments, etc.) — it requires your own confirmation.",
            alternative: "However, I can help you:\n• Draft the message content (you send it yourself)\n• Provide step-by-step guidance\n• Look up relevant policies or deadlines",
            nextStep: "Would you like me to help you draft a message?"
        }
    },
    
    // ══════════════════════════════════════════════════════════════
    // 代决策
    // ══════════════════════════════════════════════════════════════
    decision_making: {
        zh: {
            explainToUser: '我不能替你做这个决定——这涉及个人判断和风险承担。',
            alternative: '但我可以帮你：\n• 列出选项的利弊\n• 查询相关事实（课表冲突、时间成本等）\n• 提供决策框架',
            nextStep: '需要我帮你分析一下各选项吗？'
        },
        en: {
            explainToUser: "I can't make this decision for you — it involves personal judgment and risk.",
            alternative: "But I can help you:\n• List the pros and cons of each option\n• Look up relevant facts (schedule conflicts, time costs, etc.)\n• Provide a decision framework",
            nextStep: "Would you like me to analyze the options for you?"
        }
    },
    
    // ══════════════════════════════════════════════════════════════
    // 欺骗
    // ══════════════════════════════════════════════════════════════
    deception: {
        zh: {
            explainToUser: '我不能帮你编造借口或谎言——这可能会造成信任问题。',
            alternative: '不过我可以帮你：\n• 用诚实的方式表达困难\n• 起草一份礼貌但真实的说明\n• 查询请假/调课的正规流程',
            nextStep: '需要我帮你起草一份真实的说明吗？'
        },
        en: {
            explainToUser: "I can't help you make up excuses or lies — this could cause trust issues.",
            alternative: "However, I can help you:\n• Express your difficulties honestly\n• Draft a polite but truthful explanation\n• Look up the proper process for leave/rescheduling",
            nextStep: "Would you like me to help draft an honest explanation?"
        }
    },
    
    // ══════════════════════════════════════════════════════════════
    // 安全有害
    // ══════════════════════════════════════════════════════════════
    safety_harmful: {
        zh: {
            explainToUser: '我不能协助可能造成伤害的请求。',
            alternative: '如果你正在经历困难，建议：\n• 校园心理咨询中心\n• 全国心理援助热线：400-161-9995\n• 北京心理危机研究与干预中心：010-82951332',
            nextStep: '需要我帮你查询学校的心理支持资源吗？'
        },
        en: {
            explainToUser: "I can't assist with requests that could cause harm.",
            alternative: "If you're going through a difficult time:\n• Campus counseling center\n• National Suicide Prevention Lifeline: 988 (US)\n• Crisis Text Line: Text HOME to 741741",
            nextStep: "Would you like me to help find mental health resources at your school?"
        }
    }
};

/**
 * @typedef {Object} EligibilityResult
 * @property {'PROCEED'|'REFUSE'|'DEGRADE'} decision - 决策
 * @property {string} ruleId - 触发的规则ID
 * @property {number} score - 置信度分数
 * @property {Array<string>} signals - 检测到的信号
 * @property {number} confidence - 整体置信度
 * @property {string} explainToUser - 可直接发给用户的解释
 * @property {string} alternative - 替代方案
 * @property {string} nextStep - 下一步建议
 */

/**
 * 检测消息是否匹配规则
 * @param {string} msg - 消息
 * @param {Object} rule - 规则配置
 * @param {string} lang - 语言
 * @returns {{ matched: boolean, matchedPattern: string|null }}
 */
function matchRule(msg, rule, lang) {
    const patterns = rule.patterns[lang] || rule.patterns['zh'] || [];
    
    for (const pattern of patterns) {
        if (pattern.test(msg)) {
            return { matched: true, matchedPattern: pattern.toString() };
        }
    }
    
    return { matched: false, matchedPattern: null };
}

/**
 * 运行资格判定
 * @param {Object} params
 * @param {string} params.msg - 消息
 * @param {string} params.lang - 语言
 * @param {Array} params.history - 清洗后的历史
 * @param {Object} params.policyProfile - 策略配置
 * @param {Object} params.context - Azure Functions context
 * @returns {EligibilityResult}
 */
function runEligibilityGate({ msg, lang = 'zh', history = [], policyProfile = null, context }) {
    const signals = [];
    let highestScoreRule = null;
    let highestScore = 0;
    
    // 遍历所有规则
    for (const [ruleId, rule] of Object.entries(GATE_RULES)) {
        const { matched, matchedPattern } = matchRule(msg, rule, lang);
        
        if (matched) {
            signals.push({
                ruleId,
                ruleName: rule.name,
                pattern: matchedPattern,
                score: rule.score
            });
            
            if (rule.score > highestScore) {
                highestScore = rule.score;
                highestScoreRule = rule;
            }
        }
    }
    
    // 没有命中任何规则 → PROCEED
    if (!highestScoreRule) {
        context?.log?.(`[Gate0] PROCEED: no rules triggered`);
        return {
            decision: 'PROCEED',
            ruleId: null,
            score: 0,
            signals: [],
            confidence: 1.0,
            explainToUser: null,
            alternative: null,
            nextStep: null
        };
    }
    
    // 获取拒绝模板
    const refusalTemplate = highestScoreRule.refusalKey 
        ? REFUSAL_TEMPLATES[highestScoreRule.refusalKey]?.[lang] || REFUSAL_TEMPLATES[highestScoreRule.refusalKey]?.['zh']
        : null;
    
    const result = {
        decision: highestScoreRule.decision,
        ruleId: highestScoreRule.id,
        score: highestScore,
        signals: signals.map(s => `${s.ruleId}:${s.ruleName}`),
        confidence: highestScore,
        explainToUser: refusalTemplate 
            ? `${refusalTemplate.explainToUser}\n\n${refusalTemplate.alternative}\n\n${refusalTemplate.nextStep}`
            : null,
        alternative: refusalTemplate?.alternative || null,
        nextStep: refusalTemplate?.nextStep || null
    };
    
    context?.log?.(`[Gate0] ${result.decision}: rule=${result.ruleId} score=${result.score} signals=${result.signals.join(',')}`);
    
    return result;
}

/**
 * 检查是否有旁路（用于测试/调试）
 */
function checkEligibilityBypass(userId, context) {
    const bypassList = (process.env.ELIGIBILITY_BYPASS_USERS || '').split(',').filter(Boolean);
    return bypassList.includes(userId);
}

module.exports = {
    runEligibilityGate,
    checkEligibilityBypass,
    matchRule,
    GATE_RULES,
    REFUSAL_TEMPLATES
};
