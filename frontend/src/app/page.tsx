'use client';

import { FormEvent, useMemo, useRef, useState } from 'react';
import styles from './page.module.css';

type ToolCall = {
  tool?: string;
  status?: string;
  duration_ms?: number;
  error?: string | null;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCall[];
  meta?: unknown;
  safety?: unknown;
};

function parseSseEvents(raw: string): string[] {
  return raw
    .split('\n\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
    .filter(Boolean);
}

export default function ChatPage() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const sessionIdRef = useRef(`web_ui_${Date.now()}`);
  const userId = 'web_ui_user';

  const reversed = useMemo(() => [...messages].reverse(), [messages]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: text,
      toolCalls: []
    };

    const assistantId = `a_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      toolCalls: []
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setBusy(true);
    setError('');

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: text,
          channel: 'web',
          user_id: userId,
          context_id: sessionIdRef.current
        })
      });

      if (!response.ok || !response.body) {
        const fallback = await response.text();
        throw new Error(fallback || `stream_failed_${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;

      while (!done) {
        const part = await reader.read();
        done = part.done;
        buffer += decoder.decode(part.value || new Uint8Array(), { stream: !done });

        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const block of chunks) {
          for (const data of parseSseEvents(block)) {
            if (data === '[DONE]') continue;
            let eventData: any;
            try {
              eventData = JSON.parse(data);
            } catch {
              continue;
            }

            if (eventData.type === 'token') {
              const token = String(eventData.content || '');
              setMessages((prev) => prev.map((m) => {
                if (m.id !== assistantId) return m;
                return { ...m, content: `${m.content}${token}` };
              }));
              continue;
            }

            if (eventData.type === 'tool_call') {
              setMessages((prev) => prev.map((m) => {
                if (m.id !== assistantId) return m;
                return {
                  ...m,
                  toolCalls: [...m.toolCalls, {
                    tool: eventData.tool,
                    status: eventData.status,
                    duration_ms: eventData.duration_ms,
                    error: eventData.error || null
                  }]
                };
              }));
              continue;
            }

            if (eventData.type === 'meta') {
              setMessages((prev) => prev.map((m) => {
                if (m.id !== assistantId) return m;
                return {
                  ...m,
                  meta: eventData.meta,
                  safety: eventData.safety
                };
              }));
              continue;
            }

            if (eventData.type === 'error') {
              throw new Error(String(eventData.message || 'stream_error'));
            }
          }
        }
      }
    } catch (err) {
      const msg = String((err as Error)?.message || err || 'chat_failed');
      setError(msg);
      setMessages((prev) => prev.map((m) => {
        if (m.id !== assistantId) return m;
        if (m.content) return m;
        return { ...m, content: `请求失败：${msg}` };
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.wrap}>
      <div className={styles.leftPane}>
        <div className={styles.panelTitle}>Conversation</div>
        {error ? <div className={styles.error}>{error}</div> : null}
        <div className={styles.timeline}>
          {reversed.length === 0 ? (
            <div className={styles.empty}>输入消息开始会话，支持 SSE 流式返回与 tool_calls 展示。</div>
          ) : reversed.map((msg) => (
            <article key={msg.id} className={`${styles.message} ${msg.role === 'user' ? styles.user : styles.assistant}`}>
              <header className={styles.messageHeader}>{msg.role === 'user' ? 'You' : 'SchoolBot'}</header>
              <div className={styles.messageBody}>{msg.content || (msg.role === 'assistant' ? '…' : '')}</div>

              {msg.toolCalls.length > 0 ? (
                <div className={styles.tools}>
                  {msg.toolCalls.map((tc, idx) => (
                    <div key={`${msg.id}_${idx}`} className={styles.toolCard}>
                      <div className={styles.toolName}>{tc.tool || 'unknown_tool'}</div>
                      <div className={styles.toolMeta}>status={tc.status || 'unknown'} · {tc.duration_ms ?? 0}ms</div>
                      {tc.error ? <div className={styles.toolError}>{tc.error}</div> : null}
                    </div>
                  ))}
                </div>
              ) : null}

              {msg.meta ? (
                <details className={styles.details}>
                  <summary>Meta / Safety</summary>
                  <pre>{JSON.stringify({ meta: msg.meta, safety: msg.safety }, null, 2)}</pre>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      </div>

      <aside className={styles.rightPane}>
        <div className={styles.panelTitle}>Send Message</div>
        <form onSubmit={onSubmit} className={styles.form}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入内容，例如：帮我查一下明天课程，或执行 computer-use。"
            rows={8}
            className={styles.textarea}
          />
          <button type="submit" disabled={busy || !input.trim()} className={styles.submit}>
            {busy ? 'Streaming…' : 'Send'}
          </button>
        </form>

        <div className={styles.note}>
          当前通过前端代理路由请求后端，签名密钥只在 Next 服务器端使用。
        </div>
      </aside>
    </section>
  );
}
