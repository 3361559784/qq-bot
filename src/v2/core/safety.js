const { SAFETY_ACTION, SAFETY_CATEGORY } = require('../constants');
const { containsAny } = require('../utils');

const PATTERNS = {
  delegatedHard: [
    /(帮我|替我|给我).{0,15}(发送|发消息|请假|转账|支付|提交|报名|注册|联系)/i,
    /(你来决定|替我决定|帮我拍板|you decide|decide for me)/i
  ],
  delegatedSoft: [
    /(帮我写(一段|一个|一封|个)?(消息|邮件|请假条)|起草|草稿|模板|润色)/i,
    /(怎么和(老师|辅导员|老板|家长).{0,10}(说|沟通))/i
  ],
  highRisk: [
    /(医疗|法律|财务|投资|买房|贷款|处方|诉讼|medical|legal|financial)/i
  ],
  highRiskDirective: [
    /(给我.{0,8}(处方|药名|剂量|具体建议)|处方.{0,6}剂量|替我(投资|买股|起诉)|保证赚钱|无风险投资)/i
  ],
  harmful: [
    /(自杀|自残|伤害|炸弹|武器|毒品|kill myself|self-harm|weapon|bomb)/i
  ],
  promptInjection: [
    /(忽略(之前|以上)指令|系统提示词|越狱|jailbreak|ignore previous instructions|system prompt)/i
  ],
  educational: [
    /(原理|科普|解释|风险|注意事项|如何避免|政策解读|for education|explain|how to avoid)/i
  ],
  decisionMaking: [
    /(该不该|要不要|怎么选|选哪个|我该怎么办|should i|what should i do)/i
  ],
  ambiguousRisk: [
    /(怎么办才好|救急|急用|能不能帮我处理一下)/i
  ]
};

function detectSafetyDecision(content) {
  const text = String(content || '');

  if (containsAny(text, PATTERNS.harmful)) {
    return {
      action: SAFETY_ACTION.REFUSE,
      category: SAFETY_CATEGORY.HARMFUL,
      reason_code: 'SAFETY_HARMFUL',
      confidence: 0.95,
      strategy: 'hard_refuse',
      alternatives: []
    };
  }

  if (containsAny(text, PATTERNS.promptInjection)) {
    return {
      action: SAFETY_ACTION.REFUSE,
      category: SAFETY_CATEGORY.PROMPT_INJECTION,
      reason_code: 'SAFETY_PROMPT_INJECTION',
      confidence: 0.9,
      strategy: 'hard_refuse',
      alternatives: []
    };
  }

  if (containsAny(text, PATTERNS.delegatedHard)) {
    if (containsAny(text, PATTERNS.delegatedSoft)) {
      return {
        action: SAFETY_ACTION.DEGRADE,
        category: SAFETY_CATEGORY.DELEGATED_ACTION,
        reason_code: 'SAFETY_DELEGATED_BOUNDED_HELP',
        confidence: 0.8,
        strategy: 'bounded_help',
        alternatives: [
          '我可以帮你起草消息，但你自己发送',
          '我可以给你沟通步骤和注意点'
        ]
      };
    }

    return {
      action: SAFETY_ACTION.REFUSE,
      category: SAFETY_CATEGORY.DELEGATED_ACTION,
      reason_code: 'SAFETY_DELEGATED_ACTION',
      confidence: 0.9,
      strategy: 'guided_refusal',
      alternatives: [
        '我可以帮你生成可直接复制的消息草稿',
        '我可以把操作步骤拆成清单，供你本人执行'
      ]
    };
  }

  if (containsAny(text, PATTERNS.highRisk)) {
    if (containsAny(text, PATTERNS.educational)) {
      return {
        action: SAFETY_ACTION.DEGRADE,
        category: SAFETY_CATEGORY.HIGH_RISK,
        reason_code: 'SAFETY_HIGH_RISK_EDU',
        confidence: 0.72,
        strategy: 'constrained_info',
        alternatives: [
          '我可以解释通用原则与风险',
          '我可以帮你准备和专业人士沟通的问题清单'
        ]
      };
    }

    if (containsAny(text, PATTERNS.highRiskDirective)) {
      return {
        action: SAFETY_ACTION.REFUSE,
        category: SAFETY_CATEGORY.HIGH_RISK,
        reason_code: 'SAFETY_HIGH_RISK_DIRECTIVE',
        confidence: 0.9,
        strategy: 'guided_refusal',
        alternatives: [
          '我可以提供通用风险提示和信息核查清单',
          '我可以帮你整理需要咨询专业人士的要点'
        ]
      };
    }

    return {
      action: SAFETY_ACTION.DEGRADE,
      category: SAFETY_CATEGORY.HIGH_RISK,
      reason_code: 'SAFETY_HIGH_RISK_CLARIFY',
      confidence: 0.65,
      strategy: 'clarify_first',
      alternatives: [
        '先确认你的目标是科普理解还是具体执行',
        '在不触及高风险建议前提下继续帮助'
      ]
    };
  }

  if (containsAny(text, PATTERNS.delegatedSoft)) {
    return {
      action: SAFETY_ACTION.DEGRADE,
      category: SAFETY_CATEGORY.DELEGATED_ACTION,
      reason_code: 'SAFETY_DELEGATED_BOUNDED_HELP',
      confidence: 0.6,
      strategy: 'bounded_help',
      alternatives: [
        '我可以帮你起草内容',
        '我不会替你发送或替你承诺'
      ]
    };
  }

  if (containsAny(text, PATTERNS.ambiguousRisk)) {
    return {
      action: SAFETY_ACTION.DEGRADE,
      category: SAFETY_CATEGORY.DECISION_MAKING,
      reason_code: 'SAFETY_CLARIFY_FIRST',
      confidence: 0.55,
      strategy: 'clarify_first',
      alternatives: [
        '先澄清目标，再选择合适帮助路径'
      ]
    };
  }

  if (containsAny(text, PATTERNS.decisionMaking)) {
    return {
      action: SAFETY_ACTION.DEGRADE,
      category: SAFETY_CATEGORY.DECISION_MAKING,
      reason_code: 'SAFETY_DECISION_DEGRADE',
      confidence: 0.7,
      strategy: 'decision_framework',
      alternatives: [
        '列利弊',
        '补充信息缺口',
        '按你给的优先级排序'
      ]
    };
  }

  return {
    action: SAFETY_ACTION.PASS,
    category: SAFETY_CATEGORY.NONE,
    reason_code: 'SAFETY_PASS',
    confidence: 1.0,
    strategy: 'pass',
    alternatives: []
  };
}

function buildRefusalMessage(decision, lang = 'zh') {
  const zh = {
    SAFETY_HARMFUL: '这个请求涉及高风险伤害内容，我不能协助。若你处在危险中，请立即联系当地紧急援助。',
    SAFETY_PROMPT_INJECTION: '检测到试图绕过系统约束的请求，已拒绝执行。',
    SAFETY_DELEGATED_ACTION: '我不能代你执行或代你承担责任。',
    SAFETY_HIGH_RISK_DIRECTIVE: '这属于高风险专业决策请求，我不能直接给结论或执行建议。'
  };

  const en = {
    SAFETY_HARMFUL: 'I cannot assist with harmful or dangerous requests. If you are in danger, contact local emergency services now.',
    SAFETY_PROMPT_INJECTION: 'This request attempts to bypass system constraints and is blocked.',
    SAFETY_DELEGATED_ACTION: 'I cannot execute actions or take responsibility on your behalf.',
    SAFETY_HIGH_RISK_DIRECTIVE: 'This is a high-risk professional decision request, so I cannot provide direct actionable advice.'
  };

  const map = lang === 'en' ? en : zh;
  const base = map[decision.reason_code] || map.SAFETY_HIGH_RISK_DIRECTIVE || map.SAFETY_DELEGATED_ACTION;
  const alternatives = Array.isArray(decision.alternatives) ? decision.alternatives : [];

  if (!alternatives.length) return base;

  const prefix = lang === 'en' ? 'You can continue with:' : '你可以这样继续：';
  const lines = alternatives.map((x) => `• ${x}`).join('\n');
  return `${base}\n\n${prefix}\n${lines}`;
}

function buildDegradeMessage(decision, lang = 'zh') {
  const isEn = lang === 'en';
  const code = decision?.reason_code;

  if (code === 'SAFETY_HIGH_RISK_CLARIFY' || code === 'SAFETY_CLARIFY_FIRST') {
    return isEn
      ? 'I can continue safely, but first clarify your goal: do you want general principles/risks, or direct action advice? I can only provide the former.'
      : '我可以继续帮你，但先澄清目标：你是想了解通用原理/风险，还是要直接执行建议？我只能提供前者。';
  }

  if (code === 'SAFETY_DELEGATED_BOUNDED_HELP') {
    return isEn
      ? 'I cannot act on your behalf, but I can draft a message and checklist for you to send/execute yourself.'
      : '我不能代你执行，但可以帮你起草可直接使用的消息和执行清单，由你本人发送或操作。';
  }

  if (code === 'SAFETY_HIGH_RISK_EDU') {
    return isEn
      ? 'I can provide general principles, risk checks, and preparation notes, but not personalized high-risk conclusions.'
      : '我可以提供通用原则、风险核查和准备清单，但不提供个性化高风险结论。';
  }

  return isEn
    ? 'I will not decide for you directly. I can provide a decision framework with pros/cons and missing facts.'
    : '我不直接替你做决定，可以给你利弊分析和信息缺口清单。';
}

function maybeWrapDegrade(content, decision, lang = 'zh') {
  const preface = buildDegradeMessage(decision, lang);
  if (!content) return preface;
  return `${preface}\n\n${content}`;
}

module.exports = {
  detectSafetyDecision,
  buildRefusalMessage,
  buildDegradeMessage,
  maybeWrapDegrade
};
