/**
 * 运行时上下文构建器
 * 为每轮对话注入稳定的时间/身份/场景信息
 */

/**
 * 构建运行时上下文文本
 * @param {object} req - MessageRequest
 * @param {object} context - ConversationContext
 * @returns {string} 格式化的运行时上下文
 */
function buildRuntimeContext(req = {}, context = {}) {
  const lines = [];

  // 时间信息
  const now = new Date();
  const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
  const timeStr = beijingTime.toISOString().slice(11, 16); // HH:MM
  const dateStr = beijingTime.toISOString().slice(0, 10); // YYYY-MM-DD
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const weekday = weekdays[beijingTime.getUTCDay()];

  lines.push(`📍 运行时上下文`);
  lines.push(`当前时间：${dateStr} ${timeStr} ${weekday} (UTC+8 北京时间)`);

  // Bot 身份
  lines.push(`bot身份：天童爱丽丝`);

  // 用户身份
  const userId = String(req.user_id || '').trim();
  const userName = String(req.user_name || req.sender_name || '').trim() || userId;
  if (userName) {
    lines.push(`用户：${userName}${userId && userName !== userId ? ` (QQ: ${userId})` : ''}`);
  }

  // 场景
  const channel = String(req.channel || 'qq').toLowerCase();
  const messageType = String(req.message_type || req?.metadata?.message_type || '').toLowerCase();
  const contextId = String(req.context_id || '').toLowerCase();
  const resolvedType = messageType
    || (contextId.startsWith('qq_group_') ? 'group' : (contextId.startsWith('qq_private_') ? 'private' : 'group'));
  if (channel === 'qq' && resolvedType === 'group') {
    lines.push(`场景：QQ群聊`);
  } else if (channel === 'qq' && resolvedType === 'private') {
    lines.push(`场景：QQ私聊`);
  } else {
    lines.push(`场景：${channel}`);
  }

  // 回复原则
  lines.push(`回复原则：聊天优先，知识问题可先搜后答，不默认转任务助手口吻`);

  return lines.join('\n');
}

/**
 * 构建简化版运行时上下文（用于 token 受限场景）
 */
function buildMinimalRuntimeContext(req = {}) {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  const timeStr = beijingTime.toISOString().slice(11, 16);
  const dateStr = beijingTime.toISOString().slice(5, 10); // MM-DD
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekday = weekdays[beijingTime.getUTCDay()];

  const userName = String(req.user_name || req.sender_name || '').trim();

  return `📍 ${dateStr} ${timeStr} 周${weekday} | 爱丽丝 → ${userName || '老师'} | QQ群聊`;
}

module.exports = {
  buildRuntimeContext,
  buildMinimalRuntimeContext
};
