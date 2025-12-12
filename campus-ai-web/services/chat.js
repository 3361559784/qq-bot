const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 调用后端 /api/chat
 * - POST { message, sessionId }
 * - 返回 { reply }
 * - 内置 15s 超时与异常兜底
 */
export async function sendMessage(message, sessionId, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  if (!message || typeof message !== "string") {
    return { reply: "消息不能为空" };
  }
  if (!sessionId || typeof sessionId !== "string") {
    return { reply: "缺少 sessionId" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
      return { reply: `请求失败(${response.status}): ${statusText}` };
    }

    const reply = typeof data?.reply === "string" && data.reply.trim() ? data.reply : "抱歉，我现在无法回答。";
    return { reply };
  } catch (err) {
    const isAbort = err && typeof err === "object" && err.name === "AbortError";
    return { reply: isAbort ? "请求超时(15s)，请稍后重试" : "网络异常，请稍后重试" };
  } finally {
    clearTimeout(timeoutId);
  }
}
