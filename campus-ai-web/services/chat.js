const DEFAULT_TIMEOUT_MS = Infinity;

// 情绪标签正则：[happy], [sad], [panicked] 等
// 允许前导空白，避免后端偶发换行/空格导致解析失败
const EMOTION_TAG_REGEX = /^\s*\[(\w+)\]\s*/;

// 有效的情绪标签列表（与 AliceAvatar.tsx 的 AliceEmotion 对齐）
const VALID_EMOTIONS = new Set([
  "normal", "happy", "joyful", "smile", "sad", "angry",
  "panicked", "shy", "bashful", "thinking", "anxious",
  "worried", "calm", "aggrieved"
]);

// 兼容后端/模型可能输出的同义情绪标签
// 目的：不让 [excited] 之类出现在 UI，同时尽可能驱动头像表情。
const EMOTION_SYNONYM_MAP = {
  excited: "joyful",
  cheerful: "happy",
  delighted: "joyful",
  furious: "angry",
  mad: "angry",
  annoyed: "aggrieved",
  upset: "aggrieved",
  neutral: "normal",
};

/**
 * 解析并移除情绪标签
 * @param {string} text - 原始回复文本
 * @returns {{ cleanText: string, emotion: string | null }}
 */
export function parseEmotionTag(text) {
  if (!text || typeof text !== "string") {
    return { cleanText: text || "", emotion: null };
  }

  // 支持多个前导标签：例如 "[thinking] [joyful] ..."
  let remaining = text;
  let lastTag = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const match = remaining.match(EMOTION_TAG_REGEX);
    if (!match) break;
    lastTag = match[1]?.toLowerCase?.() || null;
    remaining = remaining.replace(EMOTION_TAG_REGEX, "");
  }

  const mapped = lastTag && (VALID_EMOTIONS.has(lastTag) ? lastTag : (EMOTION_SYNONYM_MAP[lastTag] || null));
  const cleanText = remaining.trim();

  // 只要检测到过标签，就剥离（避免 UI 出现 [xxx]）
  if (lastTag) {
    return { cleanText, emotion: mapped };
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
  const mode = typeof options.mode === "string" ? options.mode : undefined;
  const schedule = Array.isArray(options.schedule) ? options.schedule : undefined;
  const curriculumUuid = typeof options.curriculumUuid === "string" ? options.curriculumUuid : undefined;
  // 🆕 用户可选的人格模式：'alice' | 'professional'
  const persona = typeof options.persona === "string" ? options.persona : undefined;

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
      body: JSON.stringify({
        message,
        sessionId,
        ...(mode ? { mode } : {}),
        ...(schedule ? { schedule } : {}),
        ...(curriculumUuid ? { curriculumUuid } : {}),  // 🆕 传递 curriculumUuid
        ...(persona ? { persona } : {}),  // 🆕 传递 persona (alice/professional)
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
 * @param {string} sessionId - 会话ID
 * @param {Object} options - 可选参数
 * @param {string} options.mood - 当前心情状态 (happy/normal/annoyed/angry)
 */
export async function sendPoke(sessionId, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const mood = options.mood || "normal";

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
        isPoke: true,
        mood // 传递当前心情状态
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
