/**
 * 🚀 流式聊天 API - 支持 SSE (Server-Sent Events)
 * 实现类似 ChatGPT 的逐字显示效果 + 思考过程展示
 */
export const runtime = 'nodejs';

import crypto from 'crypto';

// SSE 编码器
function encodeSSE(data: object | string): string {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${json}\n\n`;
}

export async function POST(req: Request) {
  const requestId = crypto.randomUUID();
  
  try {
    const { message, sessionId, mode = 'Ask', schedule, curriculumUuid, persona } = await req.json();

    if (!message || typeof message !== 'string') {
      return new Response(
        encodeSSE({ type: 'error', message: '消息不能为空' }),
        { 
          status: 400, 
          headers: { 
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          } 
        }
      );
    }

    const safeSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'web_unknown';

    // Azure Functions URL
    // 线上环境对路径大小写可能敏感：统一归一到 /api/schoolbot
    const azureFunctionUrl = (() => {
      const raw =
        process.env.NEXT_PUBLIC_AZURE_FUNCTION_URL ||
        process.env.AZURE_FUNCTION_URL ||
        'https://school-bot-gwb4a9gkdwcyhde5.koreacentral-01.azurewebsites.net/api/schoolbot';

      const normalize = (value: string) =>
        value.replace(/\/api\/schoolBot/gi, '/api/schoolbot');

      try {
        const u = new URL(raw);
        u.pathname = normalize(u.pathname);
        return u.toString();
      } catch {
        return normalize(raw);
      }
    })();

    // 创建流式响应
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    // 异步处理
    (async () => {
      try {
        // 阶段1: 发送思考状态
        await writer.write(encoder.encode(encodeSSE({ 
          type: 'thinking', 
          stage: '🔍 理解问题...' 
        })));

        // 阶段2: 调用后端
        await writer.write(encoder.encode(encodeSSE({ 
          type: 'thinking', 
          stage: '🧠 Aris 正在思考...' 
        })));

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);

        // 检查后端是否支持流式
        const backendResponse = await fetch(azureFunctionUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-request-id': requestId,
            'x-stream': 'true',  // 告知后端希望流式响应
          },
          signal: controller.signal,
          body: JSON.stringify({
            post_type: 'message',
            message_type: 'private',
            raw_message: message,
            user_id: safeSessionId,
            sender: { nickname: 'Web' },
            message,
            sessionId: safeSessionId,
            mode,
            schedule: Array.isArray(schedule) ? schedule : undefined,
            curriculumUuid: typeof curriculumUuid === 'string' ? curriculumUuid : undefined,
            persona: persona === 'professional' ? 'professional' : undefined,
            stream: true,  // 请求流式响应
            requestId,
          })
        }).finally(() => clearTimeout(timeout));

        // 检查响应类型
        const contentType = backendResponse.headers.get('content-type') || '';
        
        if (contentType.includes('text/event-stream')) {
          // 后端支持流式：直接转发
          await writer.write(encoder.encode(encodeSSE({ 
            type: 'thinking', 
            stage: '✨ 生成回复中...' 
          })));

          const reader = backendResponse.body?.getReader();
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await writer.write(value);
            }
          }
        } else {
          // 后端不支持流式：模拟逐字输出
          const rawText = await backendResponse.text();
          let data;
          try {
            data = JSON.parse(rawText);
          } catch {
            data = { reply: rawText || '解析错误' };
          }

          // 发送工具调用信息（如果有）
          if (data?.meta?.tool) {
            await writer.write(encoder.encode(encodeSSE({ 
              type: 'tool_call', 
              tool: data.meta.tool,
              status: '已完成'
            })));
          }

          await writer.write(encoder.encode(encodeSSE({ 
            type: 'thinking', 
            stage: '✍️ 组织语言...' 
          })));

          // 获取回复文本
          const reply = 
            data?.reply || 
            data?.body?.reply || 
            data?.jsonBody?.reply || 
            '抱歉，我现在无法回答';

          // 模拟打字机效果 - 逐字符发送
          const chars = [...reply];
          const chunkSize = 3; // 每次发送 3 个字符，平衡速度和效果
          
          for (let i = 0; i < chars.length; i += chunkSize) {
            const chunk = chars.slice(i, i + chunkSize).join('');
            await writer.write(encoder.encode(encodeSSE({ 
              type: 'token', 
              content: chunk 
            })));
            // 短暂延迟模拟打字效果
            await new Promise(r => setTimeout(r, 20));
          }

          // 发送元数据
          await writer.write(encoder.encode(encodeSSE({ 
            type: 'meta',
            persona: data?.persona || null,
            meta: data?.meta || null,
          })));

          // 发送完成信号
          await writer.write(encoder.encode(encodeSSE({ type: 'complete' })));
        }

        await writer.write(encoder.encode('data: [DONE]\n\n'));

      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[Stream API Error]', error);
        await writer.write(encoder.encode(encodeSSE({ 
          type: 'error', 
          message: msg.includes('abort') ? '请求超时' : msg 
        })));
      } finally {
        await writer.close();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-Id': requestId,
      },
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Stream API Setup Error]', error);
    return new Response(
      encodeSSE({ type: 'error', message: msg }),
      { 
        status: 500,
        headers: { 
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        } 
      }
    );
  }
}
