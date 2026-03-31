/**
 * Compaction Service
 * 自动压缩长对话历史（append-only 模式）
 */

const { chatWithFallback } = require('../services/llmService');
const { generateId, nowIso } = require('../utils');

function computeCompactionWindow(transcript = [], options = {}) {
  const rows = Array.isArray(transcript) ? transcript : [];
  const keepRecent = Number(options.keepRecent || 8);
  const lastCompaction = [...rows].reverse().find((x) => x?.type === 'compaction');
  const previousKeptFromTurn = Number(
    options.previousKeptFromTurn
    ?? lastCompaction?.kept_from_turn
    ?? 0
  );

  const dialogEntries = rows
    .map((entry, idx) => ({ entry, idx }))
    .filter(({ entry }) => entry?.type === 'user' || entry?.type === 'assistant');

  if (dialogEntries.length <= keepRecent) {
    return { fromTurn: previousKeptFromTurn, toTurn: previousKeptFromTurn, sourceTurnCount: 0 };
  }

  const keepAnchor = dialogEntries[dialogEntries.length - keepRecent];
  const toTurn = Number(keepAnchor?.idx || 0);
  const fromTurn = Math.max(0, previousKeptFromTurn);

  if (toTurn <= fromTurn) {
    return { fromTurn, toTurn, sourceTurnCount: 0 };
  }

  const sourceTurnCount = rows
    .slice(fromTurn, toTurn)
    .filter((e) => e?.type === 'user' || e?.type === 'assistant').length;

  return { fromTurn, toTurn, sourceTurnCount };
}

/**
 * 生成 compaction 摘要
 * @param {Array} transcript - 要压缩的 transcript 条目
 * @param {object} context - 上下文
 * @returns {Promise<string>} 摘要文本
 */
async function generateCompactionSummary(transcript, context = null) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return null;
  }
  
  // 只摘要 user/assistant 对话
  const dialogEntries = transcript.filter(
    (e) => e.type === 'user' || e.type === 'assistant'
  );
  
  if (dialogEntries.length === 0) {
    return null;
  }
  
  // 构建摘要 prompt
  const dialogText = dialogEntries
    .map((e) => `${e.type === 'user' ? 'User' : 'Assistant'}: ${String(e.content || '').trim()}`)
    .join('\n\n');
  
  const messages = [
    {
      role: 'system',
      content: `你是对话摘要助手。请将以下对话压缩成简洁摘要。

摘要要求：
- 保留人物关系、重要偏好、持续话题
- 保留未完成的事项、约束、承诺
- 保留“当前仍在进行的任务/问题”与下一步
- 去除重复、无关紧要的闲聊
- 用简短客观中文描述
- 不超过 260 字

输出格式：纯文本摘要，不需要标题或分段。`
    },
    {
      role: 'user',
      content: `对话内容：\n\n${dialogText}`
    }
  ];
  
  try {
    const llm = await chatWithFallback(messages, {
      temperature: 0.3,
      max_tokens: 500
    }, context);
    
    return llm.content?.trim() || null;
  } catch (err) {
    context?.log?.(`[compaction] LLM failed: ${err.message}`);
    return null;
  }
}

/**
 * 压缩 transcript（append-only 模式）
 * 不删除旧条目，只追加 compaction 条目
 * @param {object} chatContext - ChatContext
 * @param {string} summary - 摘要文本
 * @param {object} options - 可选参数
 * @returns {void}
 */
function compactTranscript(chatContext, summary, options = {}) {
  if (!chatContext || !Array.isArray(chatContext.transcript)) {
    return;
  }
  
  if (!summary) {
    return;
  }
  
  const KEEP_RECENT = options.keepRecent || 8;
  const transcript = chatContext.transcript;
  
  // 找到需要压缩的范围
  const dialogEntries = transcript.filter((e) => e.type === 'user' || e.type === 'assistant');
  const totalDialogTurns = dialogEntries.length;
  
  if (totalDialogTurns <= KEEP_RECENT) {
    return; // 不需要压缩
  }
  
  const compactWindow = computeCompactionWindow(transcript, {
    keepRecent: KEEP_RECENT,
    previousKeptFromTurn: options.previousKeptFromTurn
  });
  const compactUpToIndex = Number(options.toTurn ?? compactWindow.toTurn);
  const compactFromIndex = Number(options.fromTurn ?? compactWindow.fromTurn);
  const sourceTurnCount = Number(options.sourceTurnCount ?? compactWindow.sourceTurnCount);

  if (sourceTurnCount <= 0 || compactUpToIndex <= compactFromIndex) {
    return;
  }
  
  // Append-only: 添加 compaction 条目
  const compactionEntry = {
    id: generateId('turn'),
    type: 'compaction',
    summary,
    kept_from_turn: compactUpToIndex,
    source_turn_count: sourceTurnCount,
    created_at: nowIso(),
    metadata: {
      ...(options.metadata || {}),
      summarized_from_turn: compactFromIndex,
      summarized_to_turn: compactUpToIndex
    }
  };
  
  transcript.push(compactionEntry);
  
  // 更新 compaction_meta
  if (!chatContext.compaction_meta) {
    chatContext.compaction_meta = {
      compaction_count: 0,
      last_compaction_at: null,
      kept_from_turn: 0,
      source_turn_count: 0
    };
  }
  
  chatContext.compaction_meta.compaction_count += 1;
  chatContext.compaction_meta.last_compaction_at = nowIso();
  chatContext.compaction_meta.last_summarized_from_turn = compactFromIndex;
  chatContext.compaction_meta.last_summarized_to_turn = compactUpToIndex;
  chatContext.compaction_meta.kept_from_turn = compactUpToIndex;
  chatContext.compaction_meta.source_turn_count = Number(chatContext.compaction_meta.source_turn_count || 0) + sourceTurnCount;
}

module.exports = {
  computeCompactionWindow,
  generateCompactionSummary,
  compactTranscript
};
