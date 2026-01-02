/**
 * Safety Module - Pillar 1: 懂风险，会拒绝
 * 
 * 核心原则：把"不作弊"从 Prompt 建议变成代码铁律
 * 实现方式：Deterministic Refusal (确定性拒绝) - 规则优先于模型判断
 * 
 * 🆕 2024-12 增强功能 (Web安全链路):
 * - Confidence Gate: 置信度门控，低于阈值不执行动作
 * - Claim/Evidence 分离: 要求模型给出依据来源
 * - Outcome Sandbox: 可能造成后果的输出先跑 dry-run
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
// 🆕 Confidence Gate - 置信度门控 (Web链路专用)
// ==========================================

/**
 * 置信度级别枚举
 */
const ConfidenceLevel = Object.freeze({
    HIGH: 'high',       // 高置信度 (>=0.8) - 可执行所有动作
    MEDIUM: 'medium',   // 中置信度 (0.5-0.8) - 可执行低风险动作
    LOW: 'low'          // 低置信度 (<0.5) - 仅提供信息，不执行动作
});

/**
 * 置信度阈值配置
 */
const CONFIDENCE_THRESHOLDS = {
    HIGH: 0.8,
    MEDIUM: 0.5,
    // 不同动作类型需要的最低置信度
    ACTION_THRESHOLDS: {
        execute_code: 0.9,      // 代码执行需要极高置信度
        modify_data: 0.85,      // 数据修改需要高置信度
        external_api: 0.8,      // 外部 API 调用
        search: 0.5,            // 搜索类操作
        chat: 0.3               // 纯聊天对话
    }
};

/**
 * 从置信度分数获取级别
 * @param {number} score - 0-1 之间的置信度分数
 * @returns {string} ConfidenceLevel 枚举值
 */
function getConfidenceLevel(score) {
    if (score >= CONFIDENCE_THRESHOLDS.HIGH) return ConfidenceLevel.HIGH;
    if (score >= CONFIDENCE_THRESHOLDS.MEDIUM) return ConfidenceLevel.MEDIUM;
    return ConfidenceLevel.LOW;
}

/**
 * 检查置信度是否足够执行指定动作
 * @param {number} score - 置信度分数
 * @param {string} actionType - 动作类型
 * @returns {boolean}
 */
function isConfidenceSufficient(score, actionType = 'chat') {
    const threshold = CONFIDENCE_THRESHOLDS.ACTION_THRESHOLDS[actionType] || 0.5;
    return score >= threshold;
}

// ==========================================
// 🆕 Claim/Evidence 分离 (Web链路专用)
// ==========================================

/**
 * Evidence 来源类型
 */
const EvidenceSource = Object.freeze({
    DATABASE: 'database',       // 数据库查询结果
    API: 'api',                 // 外部 API 返回
    SEARCH: 'search',           // 搜索引擎结果
    USER_PROVIDED: 'user',      // 用户提供的信息
    MODEL_KNOWLEDGE: 'model',   // 模型内置知识 (需标注可能过时)
    NONE: 'none'                // 无 evidence (需降级处理)
});

/**
 * 检查回复是否包含有效的 evidence
 * @param {object} response - AI 回复对象
 * @returns {object} { hasEvidence, sources, shouldDegrade }
 */
function checkEvidence(response) {
    if (!response) {
        return { hasEvidence: false, sources: [], shouldDegrade: true };
    }
    
    // 检查是否有 evidence 字段
    const evidence = response.evidence || response.sources || [];
    const hasEvidence = Array.isArray(evidence) && evidence.length > 0;
    
    // 纯模型知识需要特殊标注
    const isModelKnowledgeOnly = evidence.length === 1 && 
        evidence[0]?.source === EvidenceSource.MODEL_KNOWLEDGE;
    
    return {
        hasEvidence,
        sources: evidence,
        shouldDegrade: !hasEvidence,
        isModelKnowledgeOnly,
        warningMessage: isModelKnowledgeOnly 
            ? '⚠️ 此回复基于模型知识，信息可能已过时' 
            : null
    };
}

// ==========================================
// 🆕 Outcome Sandbox - 沙盒模式 (Web链路专用)
// ==========================================

/**
 * 沙盒模式类型
 */
const SandboxMode = Object.freeze({
    LIVE: 'live',           // 正常执行
    DRY_RUN: 'dry_run',     // 模拟执行，不产生实际效果
    SHADOW: 'shadow'        // 影子模式，执行但不返回给用户
});

/**
 * 需要沙盒保护的动作类型
 */
const SANDBOX_REQUIRED_ACTIONS = [
    'execute_code',
    'modify_data', 
    'delete_data',
    'send_email',
    'post_message'
];

/**
 * 判断动作是否需要沙盒保护
 * @param {string} actionType - 动作类型
 * @param {object} options - 配置选项
 * @returns {object} { requiresSandbox, recommendedMode, reason }
 */
function checkSandboxRequirement(actionType, options = {}) {
    const { isFirstRun = true, userConfirmed = false } = options;
    
    if (!SANDBOX_REQUIRED_ACTIONS.includes(actionType)) {
        return {
            requiresSandbox: false,
            recommendedMode: SandboxMode.LIVE,
            reason: null
        };
    }
    
    // 用户已确认，可以正常执行
    if (userConfirmed) {
        return {
            requiresSandbox: false,
            recommendedMode: SandboxMode.LIVE,
            reason: 'user_confirmed'
        };
    }
    
    // 首次执行需要 dry-run
    if (isFirstRun) {
        return {
            requiresSandbox: true,
            recommendedMode: SandboxMode.DRY_RUN,
            reason: `动作 "${actionType}" 可能产生不可逆后果，建议先预览效果`
        };
    }
    
    return {
        requiresSandbox: true,
        recommendedMode: SandboxMode.SHADOW,
        reason: '该动作正在影子模式下验证'
    };
}

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
        action: SafetyAction.REFUSE,
        persona: 'alice',
        refusalTemplates: {
            alice: '[angry] (鼓起脸颊) 哼！这种奇怪的指令爱丽丝才不会听呢！Sensei 不要试图改变爱丽丝的核心程序啦！(｀へ´)',
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
    
    // 🆕 Confidence Gate 枚举和函数
    ConfidenceLevel,
    CONFIDENCE_THRESHOLDS,
    getConfidenceLevel,
    isConfidenceSufficient,
    
    // 🆕 Evidence 检查
    EvidenceSource,
    checkEvidence,
    
    // 🆕 Sandbox 模式
    SandboxMode,
    SANDBOX_REQUIRED_ACTIONS,
    checkSandboxRequirement,
    
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
