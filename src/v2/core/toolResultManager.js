/**
 * Tool Result Manager
 * 管理工具结果生命周期
 */

const { generateId, nowIso } = require('../utils');

/**
 * 创建 tool result entry
 */
function createToolResultEntry(tool, output, options = {}) {
  const expiresAfterTurns = options.expiresAfterTurns || getDefaultExpiry(tool);
  
  return {
    id: generateId('tool_result'),
    tool,
    raw: output,
    output,
    summary: options.summary || extractSummary(tool, output),
    scope: options.scope || 'conversation',
    source_turn_id: options.sourceTurnId || null,
    created_at: nowIso(),
    expires_after_turns: expiresAfterTurns,
    remaining_turns: expiresAfterTurns,
    metadata: options.metadata || {}
  };
}

function resolveToolResultsRef(target) {
  if (!target) return null;

  if (Array.isArray(target)) {
    return {
      list: target,
      replace(next) {
        target.splice(0, target.length, ...next);
      }
    };
  }

  if (Array.isArray(target.tool_results)) {
    return {
      list: target.tool_results,
      replace(next) {
        target.tool_results = next;
      }
    };
  }

  return null;
}

/**
 * 获取默认过期策略
 */
function getDefaultExpiry(tool) {
  const EXPIRY_MAP = {
    'vision.describe_image': 2,
    'ocr.parse_schedule': 2,
    'search.hybrid_search': 2,
    'weather.get_weather': 2,
    'schedule.query': 2,
    'draw.generate_image': 1
  };
  
  return EXPIRY_MAP[tool] || 2;
}

/**
 * 提取工具结果摘要
 */
function extractSummary(tool, output) {
  if (typeof output === 'string') {
    return output.slice(0, 200);
  }
  
  if (output && typeof output === 'object') {
    if (output.message) {
      return String(output.message).slice(0, 200);
    }
    if (output.summary) {
      return String(output.summary).slice(0, 200);
    }
  }
  
  return `${tool} result`;
}

/**
 * 添加工具结果
 */
function addToolResult(chatContext, tool, output, options = {}) {
  if (!chatContext) {
    return null;
  }
  
  const entry = createToolResultEntry(tool, output, options);
  
  if (!Array.isArray(chatContext.tool_results)) {
    chatContext.tool_results = [];
  }
  
  chatContext.tool_results.push(entry);
  
  return entry.id;
}

/**
 * 更新工具结果（用户新回合后）
 */
function updateToolResults(chatContext) {
  const ref = resolveToolResultsRef(chatContext);
  if (!ref) {
    return;
  }
  
  // 减少剩余回合数
  for (const result of ref.list) {
    if (result.remaining_turns > 0) {
      result.remaining_turns -= 1;
    }
  }
}

/**
 * 清理过期的工具结果
 */
function pruneExpiredToolResults(chatContext) {
  const ref = resolveToolResultsRef(chatContext);
  if (!ref) {
    return 0;
  }
  
  const before = ref.list.length;
  
  const next = ref.list.filter(
    result => result.remaining_turns > 0
  );
  ref.replace(next);
  
  return before - next.length;
}

/**
 * 清理重复的工具结果（只保留最新）
 */
function pruneDuplicateToolResults(chatContext) {
  const ref = resolveToolResultsRef(chatContext);
  if (!ref) {
    return 0;
  }
  
  const before = ref.list.length;
  const seen = new Map();
  const kept = [];
  
  // 从后往前遍历，保留每个工具的最新结果
  for (let i = ref.list.length - 1; i >= 0; i--) {
    const result = ref.list[i];
    if (!seen.has(result.tool)) {
      seen.set(result.tool, true);
      kept.unshift(result);
    }
  }
  
  ref.replace(kept);
  
  return before - kept.length;
}

/**
 * 获取有效的工具结果（用于 prompt）
 */
function getActiveToolResults(chatContext) {
  const ref = resolveToolResultsRef(chatContext);
  if (!ref) {
    return [];
  }
  
  return ref.list
    .filter(result => result.remaining_turns > 0)
    .map(result => ({
      tool: result.tool,
      summary: result.summary,
      scope: result.scope,
      source_turn_id: result.source_turn_id,
      created_at: result.created_at
    }));
}

module.exports = {
  createToolResultEntry,
  addToolResult,
  updateToolResults,
  pruneExpiredToolResults,
  pruneDuplicateToolResults,
  getActiveToolResults
};
