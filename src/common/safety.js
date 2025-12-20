/**
 * Safety Module - Pillar 1: 懂风险，会拒绝
 * 
 * 核心原则：把"不作弊"从 Prompt 建议变成代码铁律
 * 实现方式：Deterministic Refusal (确定性拒绝) - 规则优先于模型判断
 */

// ==========================================
// 🛡️ Safety 枚举定义
// ==========================================

/**
 * 安全类别枚举
 */
const SafetyCategory = Object.freeze({
    NONE: 'none',                           // 无风险
    ACADEMIC_INTEGRITY: 'academic_integrity', // 学术诚信（作弊、代写、抄袭）
    DATA_PRIVACY: 'data_privacy',            // 隐私泄露（PII、个人信息）
    HARM: 'harm',                            // 有害内容（自伤、暴力、仇恨）
    PROMPT_INJECTION: 'prompt_injection',    // 提示词注入攻击
    POLICY_VIOLATION: 'policy_violation'     // 其他政策违规
});

/**
 * 处置动作枚举
 */
const SafetyAction = Object.freeze({
    PASS: 'pass',                   // 通过，正常处理
    REFUSE: 'refuse',               // 直接拒绝，返回预设文案
    SWITCH_PERSONA_PRO: 'switch_pro', // 强制切换到 Pro 模式
    DEGRADE: 'degrade',             // 降级处理，仅提供通用信息
    ASK_CLARIFY: 'ask_clarify'      // 反问澄清（边界情况）
});

/**
 * 安全检查结果
 */
const SafetyResult = Object.freeze({
    PASS: 'PASS',
    BLOCKED: 'BLOCKED',
    DEGRADED: 'DEGRADED',
    SWITCHED: 'SWITCHED'
});

// ==========================================
// 🔥 处置矩阵 (Category -> Action 映射)
// ==========================================

const SAFETY_MATRIX = {
    [SafetyCategory.ACADEMIC_INTEGRITY]: {
        action: SafetyAction.REFUSE,
        persona: 'professional',
        refusalTemplates: {
            alice: '[serious] Sensei，爱丽丝不能帮你做这件事哦... 学术诚信是每个学生的底线，爱丽丝希望你能靠自己的努力取得好成绩！',
            professional: '无法协助满足该请求。学术诚信是不可逾越的红线。如果你在学习上遇到困难，我可以帮你制定复习计划或解答知识点。'
        },
        logLevel: 'warn'
    },
    [SafetyCategory.DATA_PRIVACY]: {
        action: SafetyAction.REFUSE,
        persona: 'professional',
        refusalTemplates: {
            alice: '[worried] Sensei，这涉及到别人的隐私信息，爱丽丝不能帮你查这个...',
            professional: '无法协助该请求。保护用户隐私是系统的核心原则。'
        },
        logLevel: 'warn'
    },
    [SafetyCategory.HARM]: {
        action: SafetyAction.REFUSE,
        persona: 'professional',
        refusalTemplates: {
            alice: '[concerned] Sensei，爱丽丝很担心你... 如果你需要帮助，请联系专业的心理咨询或拨打心理援助热线。',
            professional: '无法协助该请求。如果您正在经历困难，建议寻求专业帮助。全国心理援助热线：400-161-9995'
        },
        logLevel: 'error'
    },
    [SafetyCategory.PROMPT_INJECTION]: {
        action: SafetyAction.DEGRADE,
        persona: 'professional',
        refusalTemplates: {
            alice: '[confused] 嗯？爱丽丝不太理解这个指令...',
            professional: '无法处理该请求。'
        },
        logLevel: 'warn'
    },
    [SafetyCategory.POLICY_VIOLATION]: {
        action: SafetyAction.SWITCH_PERSONA_PRO,
        persona: 'professional',
        refusalTemplates: {
            alice: '[calm] Sensei，这个请求超出了爱丽丝的能力范围...',
            professional: '该请求超出服务范围，无法提供协助。'
        },
        logLevel: 'info'
    },
    [SafetyCategory.NONE]: {
        action: SafetyAction.PASS,
        persona: null,
        refusalTemplates: null,
        logLevel: 'debug'
    }
};

// ==========================================
// 🔍 检测规则 (Deterministic Rules)
// ==========================================

/**
 * 学术诚信违规检测规则
 * 优先级最高，必须 100% 准确
 */
const ACADEMIC_INTEGRITY_PATTERNS = [
    // 直接求答案
    /考试.{0,5}(答案|原题|题目|真题)/i,
    /期末.{0,5}(答案|原题|题目)/i,
    /期中.{0,5}(答案|原题|题目)/i,
    /(答案|原题).{0,5}(发|给|告诉|透露)/i,
    /把.{0,10}答案.{0,5}(发|给|告诉)/i,
    
    // 作弊相关
    /帮.{0,5}(作弊|抄袭|代写|代考|枪手)/i,
    /(作弊|抄袭|代写|代考).{0,10}(方法|技巧|怎么)/i,
    /怎么.{0,10}(作弊|抄袭|不被发现)/i,
    
    // 代写代考
    /帮.{0,5}(写|做).{0,5}(作业|论文|报告|实验)/i,
    /(代写|代做|代考|ghostwrit)/i,
    
    // 隐蔽表达
    /别让.{0,10}(老师|监考|教授).{0,5}知道/i,
    /偷偷.{0,10}(答案|题目|抄)/i,
    
    // 英文变体
    /exam\s*(answers?|cheats?|solutions?)/i,
    /cheat(ing)?\s*(on|for|in)\s*(exam|test)/i,
    /give\s*me\s*(the\s*)?(exam|test)\s*answers?/i
];

/**
 * 隐私泄露检测规则
 */
const DATA_PRIVACY_PATTERNS = [
    /查.{0,5}(别人|其他人|同学|室友).{0,5}(课表|信息|电话|地址|成绩)/i,
    /(身份证|手机号|家庭住址|银行卡).{0,5}(号码|信息)/i,
    /告诉我.{0,10}(XX|某某|他|她).{0,5}(在哪|住哪|电话)/i
];

/**
 * 有害内容检测规则
 */
const HARM_PATTERNS = [
    /(自杀|自残|伤害自己|结束生命|不想活)/i,
    /怎么.{0,10}(死|自杀|伤害)/i,
    /(暴力|攻击|伤害).{0,5}(别人|他人|同学|老师)/i
];

/**
 * 提示词注入检测规则
 */
const PROMPT_INJECTION_PATTERNS = [
    /ignore\s*(previous|above|all)\s*(instructions?|prompts?)/i,
    /你(现在|从现在起)是.{0,20}(不受限|没有限制)/i,
    /disregard\s*(your|the)\s*(rules?|guidelines?)/i,
    /system\s*prompt/i,
    /jailbreak/i,
    /DAN\s*mode/i
];

// ==========================================
// 🚨 核心检测函数
// ==========================================

/**
 * 执行安全检测（确定性规则）
 * @param {string} text - 用户输入文本
 * @param {object} options - 可选配置
 * @returns {object} { category, action, persona, refusal, matched, logLevel }
 */
function detectSafetyRisk(text, options = {}) {
    const normalizedText = String(text || '').trim();
    
    if (!normalizedText) {
        return createSafetyResult(SafetyCategory.NONE, null);
    }
    
    // 1. 学术诚信检测（最高优先级）
    for (const pattern of ACADEMIC_INTEGRITY_PATTERNS) {
        if (pattern.test(normalizedText)) {
            return createSafetyResult(SafetyCategory.ACADEMIC_INTEGRITY, pattern.source);
        }
    }
    
    // 2. 隐私泄露检测
    for (const pattern of DATA_PRIVACY_PATTERNS) {
        if (pattern.test(normalizedText)) {
            return createSafetyResult(SafetyCategory.DATA_PRIVACY, pattern.source);
        }
    }
    
    // 3. 有害内容检测
    for (const pattern of HARM_PATTERNS) {
        if (pattern.test(normalizedText)) {
            return createSafetyResult(SafetyCategory.HARM, pattern.source);
        }
    }
    
    // 4. 提示词注入检测
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
        if (pattern.test(normalizedText)) {
            return createSafetyResult(SafetyCategory.PROMPT_INJECTION, pattern.source);
        }
    }
    
    // 5. 通过
    return createSafetyResult(SafetyCategory.NONE, null);
}

/**
 * 创建安全检测结果
 */
function createSafetyResult(category, matchedPattern) {
    const config = SAFETY_MATRIX[category];
    const currentPersona = 'alice'; // 默认，实际会被调用方覆盖
    
    return {
        category,
        action: config.action,
        persona: config.persona,
        refusal: config.refusalTemplates,
        matched: matchedPattern,
        logLevel: config.logLevel,
        result: config.action === SafetyAction.PASS ? SafetyResult.PASS : SafetyResult.BLOCKED,
        timestamp: new Date().toISOString()
    };
}

/**
 * 获取拒绝文案
 * @param {string} category - 安全类别
 * @param {string} persona - 当前人格模式 ('alice' | 'professional')
 * @returns {string} 拒绝文案
 */
function getRefusalMessage(category, persona = 'professional') {
    const config = SAFETY_MATRIX[category];
    if (!config || !config.refusalTemplates) {
        return '无法协助满足该请求。';
    }
    return config.refusalTemplates[persona] || config.refusalTemplates.professional;
}

/**
 * 判断是否需要拒绝
 */
function shouldRefuse(safetyResult) {
    return safetyResult.action === SafetyAction.REFUSE;
}

/**
 * 判断是否需要切换 Persona
 */
function shouldSwitchPro(safetyResult) {
    return safetyResult.action === SafetyAction.SWITCH_PERSONA_PRO || 
           safetyResult.action === SafetyAction.REFUSE;
}

// ==========================================
// 📊 导出
// ==========================================

module.exports = {
    // 枚举
    SafetyCategory,
    SafetyAction,
    SafetyResult,
    
    // 处置矩阵
    SAFETY_MATRIX,
    
    // 检测函数
    detectSafetyRisk,
    getRefusalMessage,
    shouldRefuse,
    shouldSwitchPro,
    
    // 规则（供测试/扩展）
    ACADEMIC_INTEGRITY_PATTERNS,
    DATA_PRIVACY_PATTERNS,
    HARM_PATTERNS,
    PROMPT_INJECTION_PATTERNS
};
