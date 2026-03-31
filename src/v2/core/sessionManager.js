/**
 * Session Manager
 * 管理 QQ 群聊会话状态和 transcript
 */

const { generateId, nowIso } = require('../utils');

function parseGroupIdFromContextId(contextId = '') {
  const value = String(contextId || '').trim();
  if (!value) return '';
  const m = value.match(/^qq_group_(.+)$/i);
  return m ? String(m[1] || '').trim() : '';
}

/**
 * 生成 session key
 */
function buildSessionKey(req = {}) {
  const channel = String(req.channel || 'qq').toLowerCase();
  const messageType = String(req.message_type || req?.metadata?.message_type || '').toLowerCase();
  const contextId = String(req.context_id || '').trim();
  const inferredMessageType = messageType
    || (contextId.startsWith('qq_group_') ? 'group' : (contextId.startsWith('qq_private_') ? 'private' : ''));
  
  if (channel === 'qq' && inferredMessageType === 'group') {
    const groupId = String(req.group_id || req?.metadata?.group_id || parseGroupIdFromContextId(contextId) || '').trim();
    if (!groupId) return null;
    return `qq_group:${groupId}`;
  }
  
  // 私聊不创建 session
  if (channel === 'qq' && inferredMessageType === 'private') {
    return null;
  }
  
  return null;
}

/**
 * 创建新会话上下文
 */
function createChatContext(sessionKey, req = {}) {
  const contextId = String(req.context_id || '').trim();
  const groupId = String(req.group_id || req?.metadata?.group_id || parseGroupIdFromContextId(contextId) || '');
  return {
    session_id: sessionKey,
    channel: String(req.channel || 'qq'),
    group_id: groupId,
    user_id: String(req.user_id || ''),
    transcript: [],
    tool_results: [],
    compaction_meta: null,
    active_overlay: null,
    current_task: null,
    abort_controller: null,
    created_at: nowIso(),
    last_updated: nowIso()
  };
}

/**
 * TranscriptEntry 类型
 */
const TRANSCRIPT_ENTRY_TYPES = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  COMPACTION: 'compaction'
});

/**
 * 创建 transcript entry
 */
function createTranscriptEntry(type, content, metadata = {}) {
  const entry = {
    id: generateId('turn'),
    type,
    content: String(content || '').trim(),
    metadata: metadata || {},
    created_at: nowIso()
  };
  
  return entry;
}

/**
 * 添加 user turn 到 transcript
 */
function appendUserTurn(chatContext, content, metadata = {}) {
  if (!chatContext || !chatContext.transcript) {
    throw new Error('Invalid chatContext');
  }
  
  const entry = createTranscriptEntry(
    TRANSCRIPT_ENTRY_TYPES.USER,
    content,
    {
      user_id: chatContext.user_id,
      ...metadata
    }
  );
  
  chatContext.transcript.push(entry);
  chatContext.last_updated = nowIso();
  
  return entry.id;
}

/**
 * 添加 assistant turn 到 transcript
 */
function appendAssistantTurn(chatContext, content, metadata = {}) {
  if (!chatContext || !chatContext.transcript) {
    throw new Error('Invalid chatContext');
  }
  
  const entry = createTranscriptEntry(
    TRANSCRIPT_ENTRY_TYPES.ASSISTANT,
    content,
    metadata
  );
  
  chatContext.transcript.push(entry);
  chatContext.last_updated = nowIso();
  
  return entry.id;
}

/**
 * 添加 tool_call 到 transcript
 */
function appendToolCall(chatContext, toolName, input, metadata = {}) {
  if (!chatContext || !chatContext.transcript) {
    throw new Error('Invalid chatContext');
  }
  
  const entry = createTranscriptEntry(
    TRANSCRIPT_ENTRY_TYPES.TOOL_CALL,
    JSON.stringify({ tool: toolName, input }),
    metadata
  );
  
  chatContext.transcript.push(entry);
  chatContext.last_updated = nowIso();
  
  return entry.id;
}

/**
 * 添加 tool_result 到 transcript
 */
function appendToolResult(chatContext, toolName, output, metadata = {}) {
  if (!chatContext || !chatContext.transcript) {
    throw new Error('Invalid chatContext');
  }
  
  const entry = createTranscriptEntry(
    TRANSCRIPT_ENTRY_TYPES.TOOL_RESULT,
    JSON.stringify({ tool: toolName, output }),
    metadata
  );
  
  chatContext.transcript.push(entry);
  chatContext.last_updated = nowIso();
  
  return entry.id;
}

/**
 * 添加 compaction 到 transcript
 */
function appendCompaction(chatContext, summary, sourceCount, keptFromTurn) {
  if (!chatContext || !chatContext.transcript) {
    throw new Error('Invalid chatContext');
  }
  
  const entry = {
    id: generateId('turn'),
    type: TRANSCRIPT_ENTRY_TYPES.COMPACTION,
    summary: String(summary || '').trim(),
    kept_from_turn: Number(keptFromTurn || 0),
    source_turn_count: Number(sourceCount || 0),
    created_at: nowIso(),
    metadata: {
      compacted_at: nowIso()
    }
  };
  
  chatContext.transcript.push(entry);
  chatContext.compaction_meta = {
    last_compaction_at: nowIso(),
    total_compactions: (chatContext.compaction_meta?.total_compactions || 0) + 1
  };
  chatContext.last_updated = nowIso();
  
  return entry.id;
}

/**
 * 获取 transcript 摘录（用于 LLM prompt）
 */
function getTranscriptExcerpt(chatContext, options = {}) {
  if (!chatContext || !chatContext.transcript) {
    return { entries: [], has_compaction: false };
  }
  
  const maxEntries = options.maxEntries || 16;
  const includeTools = options.includeTools !== false;
  const keepRecentDialog = options.keepRecentDialog || 8;
  
  const transcript = chatContext.transcript;

  const compactions = transcript.filter((e) => e.type === TRANSCRIPT_ENTRY_TYPES.COMPACTION);
  const latestCompaction = compactions.length ? compactions[compactions.length - 1] : null;
  const dialogEntries = transcript.filter((e) =>
    e.type === TRANSCRIPT_ENTRY_TYPES.USER || e.type === TRANSCRIPT_ENTRY_TYPES.ASSISTANT
  );
  const recentDialog = dialogEntries.slice(-Math.max(1, keepRecentDialog));

  let entries = latestCompaction
    ? [latestCompaction, ...recentDialog]
    : recentDialog;

  if (includeTools) {
    const recentIds = new Set(recentDialog.map((x) => x.id));
    const toolEntries = transcript.filter((e) => {
      if (e.type !== TRANSCRIPT_ENTRY_TYPES.TOOL_CALL && e.type !== TRANSCRIPT_ENTRY_TYPES.TOOL_RESULT) {
        return false;
      }
      const sourceId = String(e?.metadata?.source_turn_id || '').trim();
      return sourceId ? recentIds.has(sourceId) : false;
    });
    entries = [...entries, ...toolEntries];
  }

  if (entries.length > maxEntries) {
    if (latestCompaction && entries[0]?.id === latestCompaction.id) {
      entries = [entries[0], ...entries.slice(-(maxEntries - 1))];
    } else {
      entries = entries.slice(-maxEntries);
    }
  }
  
  return {
    entries,
    has_compaction: !!latestCompaction,
    total_turns: transcript.length
  };
}

/**
 * 估算 transcript token 数
 */
function estimateTranscriptTokens(chatContext) {
  const transcript = Array.isArray(chatContext)
    ? chatContext
    : (Array.isArray(chatContext?.transcript) ? chatContext.transcript : null);

  if (!transcript) {
    return 0;
  }
  
  // 粗略估算：中文 1.5 字符 = 1 token，英文 4 字符 = 1 token
  let totalChars = 0;
  
  for (const entry of transcript) {
    const content = String(entry?.content || entry?.summary || '');
    totalChars += content.length;
  }
  
  return Math.ceil(totalChars / 2);
}

/**
 * 检查是否需要 compaction
 */
function shouldCompact(chatContext, options = {}) {
  const transcript = Array.isArray(chatContext)
    ? chatContext
    : (Array.isArray(chatContext?.transcript) ? chatContext.transcript : null);

  if (!transcript) {
    return false;
  }
  
  const maxEntries = options.maxEntries || 24;
  const maxTokens = options.maxTokens || 12000;
  
  const entryCount = transcript.length;
  const tokenCount = estimateTranscriptTokens(transcript);
  
  return entryCount > maxEntries || tokenCount > maxTokens;
}

module.exports = {
  buildSessionKey,
  createChatContext,
  TRANSCRIPT_ENTRY_TYPES,
  createTranscriptEntry,
  appendUserTurn,
  appendAssistantTurn,
  appendToolCall,
  appendToolResult,
  appendCompaction,
  getTranscriptExcerpt,
  estimateTranscriptTokens,
  shouldCompact
};
