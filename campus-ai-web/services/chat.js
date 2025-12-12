const DEFAULT_TIMEOUT_MS = Infinity;

// 情绪标签正则：[happy], [sad], [panicked] 等
const EMOTION_TAG_REGEX = /^\[(\w+)\]\s*/;

// 有效的情绪标签列表
const VALID_EMOTIONS = new Set([
  "normal", "happy", "joyful", "smile", "sad", "angry", 
  "panicked", "shy", "bashful", "thinking", "anxious", 
  "worried", "calm", "aggrieved"
]);

/**
 * 解析并移除情绪标签
 * @param {string} text - 原始回复文本
 * @returns {{ cleanText: string, emotion: string | null }}
 */
function parseEmotionTag(text) {
  if (!text || typeof text !== "string") {
    return { cleanText: text || "", emotion: null };
  }
  
  const match = text.match(EMOTION_TAG_REGEX);
  if (match && VALID_EMOTIONS.has(match[1].toLowerCase())) {
    return {
      cleanText: text.replace(EMOTION_TAG_REGEX, "").trim(),
      emotion: match[1].toLowerCase()
    };
  }
  
  return { cleanText: text, emotion: null };
}

/**
 * 调用后端 /api/chat
 * - POST { message, sessionId }
 * - 返回 { reply, emotion }
 * - 内置 15s 超时与异常兜底
 */
export async function sendMessage(message, sessionId, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  if (!message || typeof message !== "string") {
    return { reply: "消息不能为空", emotion: null };
  }
  if (!sessionId || typeof sessionId !== "string") {
    return { reply: "缺少 sessionId", emotion: null };
  }

  // 不再设置超时，不主动中断请求
  const controller = new AbortController();
  let timeoutId = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs !== Infinity) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, sessionId }),
      signal: controller.signal,
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const statusText = data?.error || data?.message || response.statusText || "请求失败";
      return { reply: `请求失败(${response.status}): ${statusText}`, emotion: "sad" };
    }

    const rawReply = typeof data?.reply === "string" && data.reply.trim() ? data.reply : "抱歉，我现在无法回答。";
    
    // 解析情绪标签
    const { cleanText, emotion } = parseEmotionTag(rawReply);
    
    return { reply: cleanText, emotion };
  } catch (err) {
    const isAbort = err && typeof err === "object" && err.name === "AbortError";
    return { 
      reply: isAbort ? "请求超时(20s)，请稍后重试" : "网络异常，请稍后重试",
      emotion: "worried"
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * 戳一戳 API
 * - POST /api/chat with poke intent
 * - 返回 { reply, emotion }
 */
export async function sendPoke(sessionId, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  if (!sessionId || typeof sessionId !== "string") {
    return { reply: null, emotion: null };
  }

  // 不再设置超时，不主动中断请求
  const controller = new AbortController();
  let timeoutId = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs !== Infinity) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ 
        message: "[poke]", // 特殊的戳一戳消息
        sessionId,
        isPoke: true 
      }),
      signal: controller.signal,
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      return { reply: null, emotion: null };
    }

    const rawReply = typeof data?.reply === "string" && data.reply.trim() ? data.reply : null;
    
    if (!rawReply) {
      return { reply: null, emotion: null };
    }

    // 解析情绪标签
    const { cleanText, emotion } = parseEmotionTag(rawReply);
    
    return { reply: cleanText, emotion: emotion || "shy" };
  } catch {
    return { reply: null, emotion: null };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
