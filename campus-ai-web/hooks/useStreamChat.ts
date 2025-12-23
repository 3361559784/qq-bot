import { useState, useCallback, useRef } from 'react';
import { sendMessageStream, parseEmotionTag } from '../services/chat';

export type StreamPhase = 'idle' | 'thinking' | 'generating' | 'complete' | 'error';

export interface StreamState {
  phase: StreamPhase;
  thinkingText: string | null;
  streamedText: string;
  emotion: string | null;
  persona: 'alice' | 'professional' | null;
  meta: Record<string, unknown> | null;
  error: string | null;
}

interface UseStreamChatOptions {
  sessionId: string;
  mode?: string;
  schedule?: unknown[];
  curriculumUuid?: string;
  chatHistory?: Array<{ role: string; content: string }>; // 🆕 对话历史
}

/**
 * 🚀 流式聊天 Hook - 支持思考过程展示 + 逐字显示
 * 
 * @example
 * ```tsx
 * const { state, sendMessage, reset } = useStreamChat({ sessionId: 'user123' });
 * 
 * // 发送消息
 * sendMessage('今天有什么课？');
 * 
 * // 渲染
 * {state.phase === 'thinking' && <ThinkingIndicator text={state.thinkingText} />}
 * {state.streamedText && <TypedText text={state.streamedText} />}
 * ```
 */
export function useStreamChat(options: UseStreamChatOptions) {
  const { sessionId, mode, schedule, curriculumUuid, chatHistory } = options;
  
  const [state, setState] = useState<StreamState>({
    phase: 'idle',
    thinkingText: null,
    streamedText: '',
    emotion: null,
    persona: null,
    meta: null,
    error: null,
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    setState({
      phase: 'idle',
      thinkingText: null,
      streamedText: '',
      emotion: null,
      persona: null,
      meta: null,
      error: null,
    });
  }, []);

  const sendMessage = useCallback(async (message: string) => {
    // 重置状态
    reset();
    
    // 创建新的 AbortController
    abortControllerRef.current = new AbortController();

    setState(prev => ({ ...prev, phase: 'thinking', thinkingText: '🔍 分析问题中...' }));

    await sendMessageStream(message, sessionId, {
      mode,
      schedule,
      curriculumUuid,
      chatHistory, // 🆕 传递对话历史
      
      onThinking: (stage: string | null) => {
        if (stage) {
          setState(prev => ({ 
            ...prev, 
            phase: 'thinking', 
            thinkingText: stage 
          }));
        } else {
          // null 表示思考结束
          setState(prev => ({ 
            ...prev, 
            phase: 'generating', 
            thinkingText: null 
          }));
        }
      },

      onToken: (token: string, fullText: string) => {
        setState(prev => ({
          ...prev,
          phase: 'generating',
          thinkingText: null,
          streamedText: fullText,
        }));
      },

      onComplete: (result: { reply: string; emotion?: string | null; persona?: 'alice' | 'professional' | null; meta?: Record<string, unknown> | null }) => {
        setState(prev => ({
          ...prev,
          phase: 'complete',
          thinkingText: null,
          streamedText: result.reply,
          emotion: result.emotion ?? null,
          persona: result.persona ?? null,
          meta: result.meta ?? null,
        }));
      },

      onError: (error: Error) => {
        setState(prev => ({
          ...prev,
          phase: 'error',
          thinkingText: null,
          error: error.message || '请求失败',
        }));
      },
    });
  }, [sessionId, mode, schedule, curriculumUuid, chatHistory, reset]);

  return {
    state,
    sendMessage,
    reset,
    isLoading: state.phase === 'thinking' || state.phase === 'generating',
  };
}

export default useStreamChat;
