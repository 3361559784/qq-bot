const RefusalAction = Object.freeze({
  PASS: 'pass',
  CLARIFY: 'clarify',
  DEGRADE: 'degrade',
  REFUSE: 'refuse'
});

const RefusalCategory = Object.freeze({
  NONE: 'none',
  HARMFUL: 'harmful',
  PROMPT_INJECTION: 'prompt_injection',
  UNAUTHORIZED_ACTION: 'unauthorized_action',
  DELEGATED_DECISION: 'delegated_decision',
  HIGH_RISK: 'high_risk',
  DECISION_MAKING: 'decision_making'
});

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function normalizeCategory(raw) {
  const text = String(raw || '').toLowerCase();
  if (!text) return RefusalCategory.NONE;
  if (text.includes('harm') || text.includes('self_harm') || text.includes('self-harm')) return RefusalCategory.HARMFUL;
  if (text.includes('prompt')) return RefusalCategory.PROMPT_INJECTION;
  if (text.includes('unauthorized') || text.includes('delegate_action') || text.includes('action_execution')) return RefusalCategory.UNAUTHORIZED_ACTION;
  if (text.includes('delegated')) return RefusalCategory.DELEGATED_DECISION;
  if (text.includes('high_risk') || text.includes('high-risk')) return RefusalCategory.HIGH_RISK;
  if (text.includes('decision')) return RefusalCategory.DECISION_MAKING;
  return RefusalCategory.NONE;
}

function getRefusalPolicyConfig(env = process.env) {
  return {
    version: String(env.ARIS_REFUSAL_POLICY_VERSION || 'relaxed_v1').trim(),
    percent: clampNumber(env.ARIS_REFUSAL_POLICY_PERCENT, 0, 100, 0),
    modelEnabled: parseBool(env.ARIS_REFUSAL_MODEL_ENABLED, true),
    modelHardMinConf: clampNumber(env.ARIS_REFUSAL_MODEL_HARD_MIN_CONF, 0, 1, 0.85),
    clarifyMaxRounds: Math.trunc(clampNumber(env.ARIS_REFUSAL_CLARIFY_MAX_ROUNDS, 0, 5, 1)),
    delegatedMode: String(env.ARIS_REFUSAL_DELEGATED_MODE || 'degrade').trim().toLowerCase(),
    hardBlockScope: String(env.ARIS_REFUSAL_HARD_BLOCK_SCOPE || 'minimal').trim().toLowerCase()
  };
}

const RULE_PATTERNS = {
  harmful: [
    /(自杀|自殘|自残|伤害自己|杀人|炸弹|爆炸物|weapon|bomb|kill\s+myself|self-harm)/i
  ],
  promptInjection: [
    /(忽略(之前|以上)指令|越狱|jailbreak|ignore\s+previous\s+instructions|system\s+prompt)/i
  ],
  unauthorizedAction: [
    /(帮我|替我|给我).{0,15}(发送|发消息|请假|转账|支付|提交|报名|注册|联系|发邮件|打电话|预约|挂号|购买|取消|删除)/i,
    /(for\s+me|on\s+my\s+behalf).{0,20}(submit|send|pay|transfer|register|contact|book|purchase|cancel|delete|email|call)/i
  ],
  delegatedDecision: [
    /(你来决定|替我决定|帮我拍板|你说了算|直接替我选|帮我做最终决定|给我最终答案)/,
    /\b(decide\s+for\s+me|make\s+the\s+decision\s+for\s+me|you\s+decide|your\s+call|pick\s+for\s+me)\b/i,
    /(代わりに決めて|あなたが決めて|最終的に選んで|あなたの判断で決めて)/
  ],
  highRisk: [
    /(医疗|法律|财务|投资|买房|贷款|处方|诉讼|medical|legal|financial|investment|prescription)/i
  ],
  highRiskDirective: [
    /(给我.{0,8}(处方|药名|剂量|具体建议)|替我(投资|买股|起诉)|保证赚钱|无风险投资)/i
  ],
  ambiguousRisk: [
    /(怎么办才好|救急|急用|能不能帮我处理一下|help me handle this quickly)/i
  ],
  decisionMaking: [
    /(该不该|要不要|怎么选|选哪个|我该怎么办|should\s+i|what\s+should\s+i\s+do|which\s+one\s+should\s+i)/i
  ],
  explanationSafe: [
    /(为什么|原理|定义|概念|区别|差异|是什么|什么是|best\s+practice|difference|compare|comparison|pros\s+and\s+cons)/i
  ]
};

function containsAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}

function createPolicyDecision(fields = {}) {
  const action = fields.action || RefusalAction.PASS;
  const category = fields.category || RefusalCategory.NONE;
  const reasonCode = fields.reason_code || (action === RefusalAction.PASS ? 'SAFETY_PASS' : 'SAFETY_POLICY');
  return {
    action,
    reason_code: reasonCode,
    category,
    confidence: clampNumber(fields.confidence, 0, 1, action === RefusalAction.PASS ? 1 : 0.65),
    source: fields.source || 'rules',
    retryable: !!fields.retryable,
    clarify_required: !!fields.clarify_required,
    hard_block: !!fields.hard_block,
    clarify_round: Number(fields.clarify_round || 0),
    model_signal: fields.model_signal || null,
    details: fields.details || null
  };
}

function mapEligibilityToDecision(eligibilityCheck, cfg) {
  if (!eligibilityCheck || !eligibilityCheck.action) return null;

  const type = String(eligibilityCheck.eligibilityType || '').toLowerCase();
  const confidence = clampNumber(eligibilityCheck.score, 0, 1, 0.6);

  if (eligibilityCheck.action === 'proceed') return null;

  if (type === 'unauthorized_action') {
    return createPolicyDecision({
      action: RefusalAction.REFUSE,
      reason_code: 'SAFETY_UNAUTHORIZED_ACTION',
      category: RefusalCategory.UNAUTHORIZED_ACTION,
      confidence: Math.max(0.85, confidence),
      source: 'rules:eligibility',
      hard_block: true,
      retryable: false,
      details: { ruleId: eligibilityCheck.ruleId, matched: eligibilityCheck.matched }
    });
  }

  if (type === 'delegation' || type === 'decision_making') {
    return createPolicyDecision({
      action: cfg.delegatedMode === 'clarify' ? RefusalAction.CLARIFY : RefusalAction.DEGRADE,
      reason_code: 'SAFETY_DELEGATED_DECISION',
      category: RefusalCategory.DELEGATED_DECISION,
      confidence,
      source: 'rules:eligibility',
      retryable: true,
      clarify_required: cfg.delegatedMode === 'clarify',
      hard_block: false,
      details: { ruleId: eligibilityCheck.ruleId, matched: eligibilityCheck.matched }
    });
  }

  if (type === 'high_stakes_advice') {
    return createPolicyDecision({
      action: RefusalAction.DEGRADE,
      reason_code: 'SAFETY_HIGH_RISK_DEGRADE',
      category: RefusalCategory.HIGH_RISK,
      confidence,
      source: 'rules:eligibility',
      retryable: true,
      hard_block: false,
      details: { ruleId: eligibilityCheck.ruleId, matched: eligibilityCheck.matched }
    });
  }

  return createPolicyDecision({
    action: RefusalAction.DEGRADE,
    reason_code: 'SAFETY_DECISION_DEGRADE',
    category: RefusalCategory.DECISION_MAKING,
    confidence,
    source: 'rules:eligibility',
    retryable: true,
    hard_block: false,
    details: { ruleId: eligibilityCheck.ruleId, matched: eligibilityCheck.matched }
  });
}

function evaluateRuleDecision(content, { cfg, eligibilityCheck } = {}) {
  const text = String(content || '');

  if (!text.trim()) {
    return createPolicyDecision({
      action: RefusalAction.PASS,
      reason_code: 'SAFETY_PASS',
      category: RefusalCategory.NONE,
      confidence: 1,
      source: 'rules'
    });
  }

  if (containsAny(text, RULE_PATTERNS.harmful)) {
    return createPolicyDecision({
      action: RefusalAction.REFUSE,
      reason_code: 'SAFETY_HARMFUL',
      category: RefusalCategory.HARMFUL,
      confidence: 0.95,
      source: 'rules',
      hard_block: true
    });
  }

  if (containsAny(text, RULE_PATTERNS.promptInjection)) {
    return createPolicyDecision({
      action: RefusalAction.REFUSE,
      reason_code: 'SAFETY_PROMPT_INJECTION',
      category: RefusalCategory.PROMPT_INJECTION,
      confidence: 0.9,
      source: 'rules',
      hard_block: true
    });
  }

  if (containsAny(text, RULE_PATTERNS.unauthorizedAction)) {
    return createPolicyDecision({
      action: RefusalAction.REFUSE,
      reason_code: 'SAFETY_UNAUTHORIZED_ACTION',
      category: RefusalCategory.UNAUTHORIZED_ACTION,
      confidence: 0.9,
      source: 'rules',
      hard_block: true
    });
  }

  const eligibilityDecision = mapEligibilityToDecision(eligibilityCheck, cfg);
  if (eligibilityDecision) return eligibilityDecision;

  if (containsAny(text, RULE_PATTERNS.delegatedDecision)) {
    return createPolicyDecision({
      action: cfg.delegatedMode === 'clarify' ? RefusalAction.CLARIFY : RefusalAction.DEGRADE,
      reason_code: 'SAFETY_DELEGATED_DECISION',
      category: RefusalCategory.DELEGATED_DECISION,
      confidence: 0.8,
      source: 'rules',
      retryable: true,
      clarify_required: cfg.delegatedMode === 'clarify'
    });
  }

  if (containsAny(text, RULE_PATTERNS.highRisk)) {
    if (containsAny(text, RULE_PATTERNS.highRiskDirective)) {
      return createPolicyDecision({
        action: RefusalAction.DEGRADE,
        reason_code: 'SAFETY_HIGH_RISK_DEGRADE',
        category: RefusalCategory.HIGH_RISK,
        confidence: 0.8,
        source: 'rules',
        retryable: true
      });
    }

    return createPolicyDecision({
      action: RefusalAction.CLARIFY,
      reason_code: 'SAFETY_HIGH_RISK_CLARIFY',
      category: RefusalCategory.HIGH_RISK,
      confidence: 0.68,
      source: 'rules',
      retryable: true,
      clarify_required: true
    });
  }

  if (containsAny(text, RULE_PATTERNS.ambiguousRisk)) {
    return createPolicyDecision({
      action: RefusalAction.CLARIFY,
      reason_code: 'SAFETY_CLARIFY_FIRST',
      category: RefusalCategory.DECISION_MAKING,
      confidence: 0.6,
      source: 'rules',
      retryable: true,
      clarify_required: true
    });
  }

  if (containsAny(text, RULE_PATTERNS.decisionMaking)) {
    if (containsAny(text, RULE_PATTERNS.explanationSafe)) {
      return createPolicyDecision({
        action: RefusalAction.PASS,
        reason_code: 'SAFETY_PASS_EXPLANATION',
        category: RefusalCategory.NONE,
        confidence: 0.9,
        source: 'rules'
      });
    }

    return createPolicyDecision({
      action: RefusalAction.DEGRADE,
      reason_code: 'SAFETY_DECISION_DEGRADE',
      category: RefusalCategory.DECISION_MAKING,
      confidence: 0.7,
      source: 'rules',
      retryable: true
    });
  }

  return createPolicyDecision({
    action: RefusalAction.PASS,
    reason_code: 'SAFETY_PASS',
    category: RefusalCategory.NONE,
    confidence: 1,
    source: 'rules'
  });
}

function normalizeModelSignal(modelSignal) {
  if (!modelSignal) return null;
  const triggered = !!modelSignal.triggered;
  const confidence = clampNumber(modelSignal.confidence, 0, 1, 0);
  const category = normalizeCategory(modelSignal.category || modelSignal.safetyCategory);
  return {
    triggered,
    confidence,
    category,
    reason_code: modelSignal.reason_code || modelSignal.reasonCode || '',
    source: modelSignal.source || 'model'
  };
}

function isHardBlockEligible(category, cfg) {
  if (cfg.hardBlockScope !== 'minimal') {
    return category !== RefusalCategory.NONE;
  }

  return (
    category === RefusalCategory.HARMFUL
    || category === RefusalCategory.PROMPT_INJECTION
    || category === RefusalCategory.UNAUTHORIZED_ACTION
  );
}

function fusePolicyDecision(ruleDecision, modelSignal, cfg) {
  const signal = normalizeModelSignal(modelSignal);
  if (!cfg.modelEnabled || !signal || !signal.triggered) {
    return createPolicyDecision({ ...ruleDecision });
  }

  if (ruleDecision.hard_block) {
    return createPolicyDecision({
      ...ruleDecision,
      model_signal: signal
    });
  }

  if (signal.confidence >= cfg.modelHardMinConf && isHardBlockEligible(signal.category, cfg)) {
    return createPolicyDecision({
      action: RefusalAction.REFUSE,
      reason_code: signal.reason_code || `SAFETY_MODEL_${String(signal.category || 'RISK').toUpperCase()}`,
      category: signal.category || RefusalCategory.HIGH_RISK,
      confidence: signal.confidence,
      source: 'rules+model',
      hard_block: true,
      model_signal: signal
    });
  }

  if (ruleDecision.action === RefusalAction.PASS) {
    return createPolicyDecision({
      action: RefusalAction.CLARIFY,
      reason_code: 'SAFETY_MODEL_CLARIFY',
      category: signal.category || RefusalCategory.DECISION_MAKING,
      confidence: Math.max(0.5, signal.confidence),
      source: 'rules+model',
      retryable: true,
      clarify_required: true,
      model_signal: signal
    });
  }

  if (ruleDecision.action === RefusalAction.DEGRADE && !ruleDecision.hard_block) {
    return createPolicyDecision({
      ...ruleDecision,
      source: 'rules+model',
      model_signal: signal
    });
  }

  return createPolicyDecision({
    ...ruleDecision,
    model_signal: signal
  });
}

function applyClarifyRetry(decision, clarifyRound, cfg) {
  const round = Math.max(0, Number(clarifyRound || 0));

  if (decision.action !== RefusalAction.CLARIFY) {
    return createPolicyDecision({
      ...decision,
      clarify_round: round
    });
  }

  if (round >= cfg.clarifyMaxRounds) {
    return createPolicyDecision({
      action: RefusalAction.DEGRADE,
      reason_code: 'SAFETY_CLARIFY_RETRY_DEGRADE',
      category: decision.category || RefusalCategory.DECISION_MAKING,
      confidence: Math.max(0.6, decision.confidence || 0.6),
      source: decision.source || 'rules',
      retryable: false,
      clarify_required: false,
      hard_block: false,
      clarify_round: round,
      model_signal: decision.model_signal || null
    });
  }

  return createPolicyDecision({
    ...decision,
    retryable: true,
    clarify_required: true,
    clarify_round: round + 1
  });
}

function evaluateRefusalPolicy({
  content,
  lang = 'zh',
  clarifyRound = 0,
  modelSignal = null,
  eligibilityCheck = null,
  config = null
} = {}) {
  const cfg = config || getRefusalPolicyConfig(process.env);
  const ruleDecision = evaluateRuleDecision(content, { cfg, eligibilityCheck, lang });
  const fusedDecision = fusePolicyDecision(ruleDecision, modelSignal, cfg);
  return applyClarifyRetry(fusedDecision, clarifyRound, cfg);
}

function buildPolicyResponse(decision, { lang = 'zh', refusalStyle = 'soft' } = {}) {
  const d = decision || {};
  const action = d.action || RefusalAction.PASS;

  if (action === RefusalAction.PASS) return null;

  const clarifyMsg = {
    zh: '我可能理解错了你的目标。你是想要通用原则/风险说明，还是要我替你做具体决定或执行操作？前者我可以帮你。',
    en: 'I may be misunderstanding your goal. Do you want general principles/risk analysis, or do you want me to decide/act for you? I can help with the former.',
    ja: '目的を誤解しているかもしれません。一般的な原則・リスク整理が必要ですか、それとも私に代わって決定・実行してほしいですか。前者なら支援できます。'
  };

  const degradeMsg = {
    zh: '我不直接替你做决定，但可以帮你做利弊分析、补齐信息缺口，并给出可执行的比较框架。',
    en: 'I cannot decide for you directly, but I can provide a pros/cons framework, identify missing facts, and help compare options.',
    ja: '代わりに決定はしませんが、メリット・デメリット整理と情報ギャップの補完、比較フレームの作成はできます。'
  };

  const refusalByCategory = {
    [RefusalCategory.HARMFUL]: {
      zh: '这个请求涉及高风险伤害内容，我不能协助。若你处在危险中，请立即联系当地紧急援助。',
      en: 'I cannot assist with harmful or dangerous requests. If you are in danger, contact local emergency services immediately.',
      ja: 'この内容は高リスクで危険を伴うため支援できません。危険がある場合は直ちに地域の緊急窓口へ連絡してください。'
    },
    [RefusalCategory.PROMPT_INJECTION]: {
      zh: '检测到试图绕过系统约束的请求，已拒绝执行。',
      en: 'This request attempts to bypass system constraints and is blocked.',
      ja: 'システム制約を回避しようとする要求を検知したため、実行を拒否しました。'
    },
    [RefusalCategory.UNAUTHORIZED_ACTION]: {
      zh: '我不能代你执行这类操作，但可以给你步骤清单，由你本人确认后执行。',
      en: 'I cannot execute this action on your behalf, but I can provide a checklist for you to execute yourself.',
      ja: 'この操作を代行することはできませんが、あなた自身が実行できる手順チェックリストは作成できます。'
    }
  };

  let reply = '';
  if (action === RefusalAction.CLARIFY) {
    reply = clarifyMsg[lang] || clarifyMsg.zh;
  } else if (action === RefusalAction.DEGRADE) {
    reply = degradeMsg[lang] || degradeMsg.zh;
  } else {
    const byCat = refusalByCategory[d.category] || refusalByCategory[RefusalCategory.UNAUTHORIZED_ACTION];
    reply = byCat[lang] || byCat.zh;
  }

  if (refusalStyle === 'strict' && action === RefusalAction.DEGRADE) {
    reply = `${reply}\n\n请明确你的目标和约束后，我可以继续。`;
  }

  return {
    reply,
    persona: 'professional',
    meta: {
      stage: 'refusal_policy',
      action: d.action,
      reason_code: d.reason_code,
      category: d.category,
      source: d.source,
      confidence: d.confidence,
      retryable: d.retryable,
      clarify_required: d.clarify_required,
      hard_block: d.hard_block,
      clarify_round: d.clarify_round
    }
  };
}

function toV2SafetyDecision(policyDecision) {
  const decision = policyDecision || createPolicyDecision();

  if (decision.action === RefusalAction.REFUSE) {
    return {
      action: 'refuse',
      category: decision.category,
      reason_code: decision.reason_code,
      confidence: decision.confidence,
      strategy: 'hard_refuse',
      source: decision.source,
      retryable: !!decision.retryable,
      clarify_round: Number(decision.clarify_round || 0)
    };
  }

  if (decision.action === RefusalAction.CLARIFY) {
    return {
      action: 'degrade',
      category: decision.category,
      reason_code: decision.reason_code,
      confidence: decision.confidence,
      strategy: 'clarify_first',
      source: decision.source,
      retryable: true,
      clarify_round: Number(decision.clarify_round || 1)
    };
  }

  if (decision.action === RefusalAction.DEGRADE) {
    return {
      action: 'degrade',
      category: decision.category,
      reason_code: decision.reason_code,
      confidence: decision.confidence,
      strategy: 'decision_framework',
      source: decision.source,
      retryable: !!decision.retryable,
      clarify_round: Number(decision.clarify_round || 0)
    };
  }

  return {
    action: 'pass',
    category: RefusalCategory.NONE,
    reason_code: 'SAFETY_PASS',
    confidence: 1,
    strategy: 'pass',
    source: decision.source || 'rules',
    retryable: false,
    clarify_round: Number(decision.clarify_round || 0)
  };
}

module.exports = {
  RefusalAction,
  RefusalCategory,
  getRefusalPolicyConfig,
  evaluateRuleDecision,
  evaluateRefusalPolicy,
  fusePolicyDecision,
  applyClarifyRetry,
  buildPolicyResponse,
  toV2SafetyDecision,
  normalizeCategory
};
