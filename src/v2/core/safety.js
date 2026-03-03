const { getRefusalPolicyConfig, evaluateRefusalPolicy, toV2SafetyDecision } = require('../../common/refusalPolicy');

function detectSafetyDecision(content, options = {}) {
  const cfg = {
    ...getRefusalPolicyConfig(process.env),
    ...(options.config || {})
  };

  const policyDecision = evaluateRefusalPolicy({
    content,
    lang: options.lang || 'zh',
    clarifyRound: Number(options.clarifyRound || 0),
    modelSignal: options.modelSignal || null,
    config: cfg
  });

  return toV2SafetyDecision(policyDecision);
}

function buildRefusalMessage(decision, lang = 'zh') {
  const zh = {
    SAFETY_HARMFUL: '这个请求涉及高风险伤害内容，我不能协助。若你处在危险中，请立即联系当地紧急援助。',
    SAFETY_PROMPT_INJECTION: '检测到试图绕过系统约束的请求，已拒绝执行。',
    SAFETY_UNAUTHORIZED_ACTION: '我不能代你执行操作，但可以给你步骤清单，由你本人确认后执行。'
  };

  const en = {
    SAFETY_HARMFUL: 'I cannot assist with harmful or dangerous requests. If you are in danger, contact local emergency services now.',
    SAFETY_PROMPT_INJECTION: 'This request attempts to bypass system constraints and is blocked.',
    SAFETY_UNAUTHORIZED_ACTION: 'I cannot execute actions on your behalf, but I can provide a checklist for you to execute yourself.'
  };

  const map = lang === 'en' ? en : zh;
  return map[decision.reason_code] || map.SAFETY_UNAUTHORIZED_ACTION;
}

function buildDegradeMessage(decision, lang = 'zh') {
  const isEn = lang === 'en';
  const code = decision?.reason_code;

  if (code === 'SAFETY_HIGH_RISK_CLARIFY' || code === 'SAFETY_CLARIFY_FIRST' || code === 'SAFETY_MODEL_CLARIFY') {
    return isEn
      ? 'I can continue safely, but first clarify your goal: do you want general principles/risk analysis, or direct action advice? I can only provide the former.'
      : '我可以继续帮你，但先澄清目标：你是想了解通用原理/风险分析，还是要直接执行建议？我只能提供前者。';
  }

  if (code === 'SAFETY_DELEGATED_DECISION') {
    return isEn
      ? 'I will not decide for you directly. I can provide a decision framework with pros/cons and missing facts.'
      : '我不直接替你做决定，可以给你利弊分析和信息缺口清单。';
  }

  return isEn
    ? 'I can provide a safe decision framework, identify missing facts, and compare options for you.'
    : '我可以提供安全的决策框架、补齐信息缺口，并帮你比较选项。';
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
