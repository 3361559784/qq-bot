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
 * 🆕 流式消息发送 - 支持边生成边显示 + 展示思考过程
 * @param {string} message - 用户消息
 * @param {string} sessionId - 会话ID
 * @param {Object} options - 配置选项
 * @param {Function} options.onThinking - 思考阶段回调 (stage: string)
 * @param {Function} options.onToken - 每个 token 回调 (token: string, fullText: string)
 * @param {Function} options.onComplete - 完成回调 (result: object)
 * @param {Function} options.onError - 错误回调 (error: Error)
 * @param {string} [options.mode] - 当前模式（Ask/Search/Plan/Class）
 * @param {Array} [options.schedule] - 课程表数组（前端透传给后端）
 * @param {string} [options.curriculumUuid] - 学习通课表 uuid（如有）
 */
export async function sendMessageStream(message, sessionId, options = {}) {
  const {
    onThinking,
    onToken,
    onComplete,
    onError,
    mode,
    schedule,
    curriculumUuid,
  } = options;

  if (!message || typeof message !== "string") {
    onError?.(new Error("消息不能为空"));
    return;
  }

  try {
    // 阶段1: 开始思考
    onThinking?.("🔍 分析问题中...");

    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        sessionId,
        stream: true,
        ...(mode ? { mode } : {}),
        ...(schedule ? { schedule } : {}),
        ...(curriculumUuid ? { curriculumUuid } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("不支持流式响应");
    }

    const decoder = new TextDecoder();
    let fullText = "";
    let currentPhase = "thinking";
    let emotion = null;
    let persona = null;
    let meta = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter(line => line.startsWith("data: "));

      for (const line of lines) {
        const data = line.slice(6); // 移除 "data: "
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);

          // 处理不同类型的事件
          switch (parsed.type) {
            case "thinking":
              currentPhase = "thinking";
              onThinking?.(parsed.stage || "思考中...");
              break;

            case "tool_call":
              onThinking?.(`🛠️ ${parsed.tool}: ${parsed.status || "调用中..."}`);
              break;

            case "token":
              if (currentPhase === "thinking") {
                currentPhase = "generating";
                onThinking?.(null); // 清除思考状态
              }
              fullText += parsed.content || "";
              onToken?.(parsed.content || "", fullText);
              break;

            case "emotion":
              emotion = parsed.emotion;
              break;

            case "meta":
              persona = parsed.persona;
              meta = parsed.meta;
              break;

            case "complete":
              // 解析情绪标签
              const { cleanText, emotion: parsedEmotion } = parseEmotionTag(fullText);
              onComplete?.({
                reply: cleanText,
                emotion: emotion || parsedEmotion,
                persona,
                meta,
              });
              break;

            case "error":
              throw new Error(parsed.message || "流式响应错误");
          }
        } catch (e) {
          // 忽略解析错误，继续处理
          console.warn("SSE parse warning:", e);
        }
      }
    }

    // 如果没有收到 complete 事件，手动完成
    if (fullText && currentPhase === "generating") {
      const { cleanText, emotion: parsedEmotion } = parseEmotionTag(fullText);
      onComplete?.({
        reply: cleanText,
        emotion: emotion || parsedEmotion,
        persona,
        meta,
      });
    }

  } catch (err) {
    onError?.(err);
  }
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
    
    const persona = (data?.persona === 'professional' || data?.persona === 'alice') ? data.persona : null;
    
    // 🆕 Pillar 4: 提取后端返回的 meta 元数据用于前端决策摘要展示
    const meta = data?.meta ? {
      requestId: data.meta.requestId,
      safety_protocol: data.meta.safety_protocol,
      safety_category: data.meta.safety_category,
      persona_switch: data.meta.persona_switch,
      source: data.meta.source,
      sourceLabel: data.meta.sourceLabel,
      trustLevel: data.meta.trustLevel,
      disclaimer: data.meta.disclaimer,
      fallbackChain: data.meta.fallbackChain,
      latencyMs: data.meta.latencyMs,
    } : undefined;
    
    return { reply: cleanText, emotion, persona, meta };
  } catch (err) {
    const isAbort = err && typeof err === "object" && err.name === "AbortError";
    return { 
      reply: isAbort ? "请求超时(20s)，请稍后重试" : "网络异常，请稍后重试",
      emotion: "worried",
      persona: null,
      meta: undefined
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
