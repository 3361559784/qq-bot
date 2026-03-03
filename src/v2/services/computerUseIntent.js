const { safeLower, trimContent } = require('../utils');

const EXPLICIT_PREFIXES = [
  '@cu',
  '/cu',
  'cu:',
  'computer-use:',
  'computer use:',
  'computeruse:',
  '电脑操作:',
  '使用电脑:'
];

const AUTO_PATTERNS = [
  /(帮我|请你|你帮我).*(点击|双击|右键|输入|滚动|打开|关闭|操作|自动化)/i,
  /(在|打开).*(软件|应用|app|浏览器|finder|系统设置).*(点击|输入|操作)/i,
  /(computer\s*use|视觉点击|桌面自动化)/i
];

function normalizeTriggerMode(mode) {
  const value = safeLower(mode);
  if (value === 'explicit' || value === 'auto' || value === 'both') return value;
  return 'both';
}

function stripExplicitPrefix(content) {
  const raw = String(content || '').trim();
  const lowered = raw.toLowerCase();

  for (const prefix of EXPLICIT_PREFIXES) {
    const p = prefix.toLowerCase();
    if (!lowered.startsWith(p)) continue;
    return trimContent(raw.slice(prefix.length).trim(), 4000);
  }

  return '';
}

function looksLikeAutoComputerUse(content) {
  const text = String(content || '').trim();
  if (!text) return false;
  return AUTO_PATTERNS.some((pattern) => pattern.test(text));
}

function detectComputerUseTrigger(content, options = {}) {
  const triggerMode = normalizeTriggerMode(options.triggerMode);
  const explicitObjective = stripExplicitPrefix(content);

  if ((triggerMode === 'explicit' || triggerMode === 'both') && explicitObjective) {
    return {
      triggered: true,
      trigger: 'explicit',
      objective: explicitObjective
    };
  }

  if ((triggerMode === 'auto' || triggerMode === 'both') && looksLikeAutoComputerUse(content)) {
    return {
      triggered: true,
      trigger: 'auto',
      objective: trimContent(String(content || '').trim(), 4000)
    };
  }

  return {
    triggered: false,
    trigger: null,
    objective: ''
  };
}

function buildComputerUseSkillInput(content, metadata = {}, options = {}) {
  const detected = detectComputerUseTrigger(content, {
    triggerMode: options.triggerMode || metadata.trigger_mode
  });

  if (!detected.triggered) {
    return {
      triggered: false,
      input: null
    };
  }

  const mergedObjective = trimContent(
    String(metadata.objective || detected.objective || '').trim(),
    4000
  );

  return {
    triggered: !!mergedObjective,
    input: mergedObjective ? {
      objective: mergedObjective,
      trigger: detected.trigger,
      metadata: {
        ...metadata,
        trigger: detected.trigger
      }
    } : null
  };
}

module.exports = {
  normalizeTriggerMode,
  detectComputerUseTrigger,
  buildComputerUseSkillInput
};

