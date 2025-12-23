'use client';

import { motion, AnimatePresence } from 'framer-motion';

interface ThinkingIndicatorProps {
  text: string | null;
  className?: string;
}

/**
 * 🧠 思考过程指示器 - 展示 AI 的思考阶段
 * 支持动画效果，类似 ChatGPT 的 "Thinking..." 显示
 */
export function ThinkingIndicator({ text, className = '' }: ThinkingIndicatorProps) {
  if (!text) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.2 }}
        className={`flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 ${className}`}
      >
        {/* 思考动画点 */}
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-blue-500"
              animate={{
                scale: [1, 1.3, 1],
                opacity: [0.5, 1, 0.5],
              }}
              transition={{
                duration: 0.8,
                repeat: Infinity,
                delay: i * 0.15,
              }}
            />
          ))}
        </div>
        
        {/* 思考文本 */}
        <motion.span
          key={text}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="italic"
        >
          {text}
        </motion.span>
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * 打字机效果文本组件
 */
interface TypedTextProps {
  text: string;
  className?: string;
  showCursor?: boolean;
}

export function TypedText({ text, className = '', showCursor = true }: TypedTextProps) {
  return (
    <span className={className}>
      {text}
      {showCursor && (
        <motion.span
          animate={{ opacity: [1, 0] }}
          transition={{ duration: 0.5, repeat: Infinity }}
          className="inline-block w-0.5 h-4 bg-blue-500 ml-0.5 align-middle"
        />
      )}
    </span>
  );
}

/**
 * 流式消息气泡 - 集成思考指示器和打字效果
 */
interface StreamingMessageProps {
  phase: 'idle' | 'thinking' | 'generating' | 'complete' | 'error';
  thinkingText: string | null;
  streamedText: string;
  error?: string | null;
  className?: string;
}

export function StreamingMessage({
  phase,
  thinkingText,
  streamedText,
  error,
  className = '',
}: StreamingMessageProps) {
  if (phase === 'idle') return null;

  return (
    <div className={`space-y-2 ${className}`}>
      {/* 思考阶段 */}
      {phase === 'thinking' && (
        <ThinkingIndicator text={thinkingText} />
      )}

      {/* 生成中/完成 - 显示文本 */}
      {(phase === 'generating' || phase === 'complete') && streamedText && (
        <div className="prose dark:prose-invert max-w-none">
          <TypedText 
            text={streamedText} 
            showCursor={phase === 'generating'} 
          />
        </div>
      )}

      {/* 错误状态 */}
      {phase === 'error' && (
        <div className="text-red-500 dark:text-red-400 text-sm">
          ❌ {error || '请求失败，请重试'}
        </div>
      )}
    </div>
  );
}

export default ThinkingIndicator;
