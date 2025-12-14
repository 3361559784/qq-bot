"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, useMotionValue, useSpring, useTransform, AnimatePresence } from "framer-motion";

// ============================
// 情绪 → 图片映射
// ============================
export type AliceEmotion =
  | "normal"
  | "happy"
  | "joyful"
  | "smile"
  | "sad"
  | "angry"
  | "panicked"
  | "shy"
  | "bashful"
  | "thinking"
  | "anxious"
  | "worried"
  | "calm"
  | "aggrieved";

const EMOTION_IMAGE_MAP: Record<AliceEmotion, string> = {
  normal: "/images/aris_normal.png",
  happy: "/images/aris_happy.png",
  joyful: "/images/aris_joyful.png",
  smile: "/images/aris_smile.png",
  sad: "/images/aris_sad.png",
  angry: "/images/aris_angry.png",
  panicked: "/images/aris_panicked.png",
  shy: "/images/aris_shy.png",
  bashful: "/images/aris_bashful-happy.png",
  thinking: "/images/aris_thoughtful.png",
  anxious: "/images/aris_anxious.png",
  worried: "/images/aris_worried.png",
  calm: "/images/aris_calm.png",
  aggrieved: "/images/aris_aggrieved.png",
};

// 预加载所有图片
const preloadImages = () => {
  if (typeof window === "undefined") return;
  Object.values(EMOTION_IMAGE_MAP).forEach((src) => {
    const img = new Image();
    img.src = src;
  });
};

// ============================
// 戳一戳情绪递进系统
// 开心 → 害羞 → 烦躁 → 生气 (固定)
// ============================
type PokeMood = "happy" | "shy" | "annoyed" | "angry";

interface PokeMoodConfig {
  emotion: AliceEmotion;
  bubbleTexts: string[];
  nextThreshold: number; // 进入下一阶段所需次数
}

const POKE_MOOD_PROGRESSION: Record<PokeMood, PokeMoodConfig> = {
  happy: {
    emotion: "happy",
    bubbleTexts: [
      "嘿嘿~",
      "Sensei!",
      "邦邦咔邦!",
      "好开心!",
      "(✨ω✨)",
      "呀~",
    ],
    nextThreshold: 2, // 2次后进入害羞
  },
  shy: {
    emotion: "shy",
    bubbleTexts: [
      "呜...好害羞",
      "别戳了啦...",
      "脸红了...",
      "(///ω///)",
      "够了啦~",
      "讨厌...",
    ],
    nextThreshold: 4, // 4次后进入烦躁
  },
  annoyed: {
    emotion: "aggrieved",
    bubbleTexts: [
      "真的够了!",
      "烦死了!",
      "不要再戳!",
      "哼!",
      "爱丽丝要生气了!",
      "最后警告!",
    ],
    nextThreshold: 6, // 6次后进入生气
  },
  angry: {
    emotion: "angry",
    bubbleTexts: [
      "爱丽丝生气了!",
      "不理你了!",
      "哼!!!",
      "讨厌Sensei!",
      "走开!",
      "反击模式启动!",
    ],
    nextThreshold: Infinity, // 固定生气
  },
};

// 情绪衰减时间(毫秒)
const MOOD_DECAY_MS = 10000; // 10秒不戳开始衰减
const MOOD_RESET_MS = 30000; // 30秒不戳完全重置

// ============================
// 组件Props
// ============================
interface AliceAvatarProps {
  onPoke?: (pokeCount: number, mood: PokeMood) => void;
  onAffectionChange?: (delta: number) => void;
  affection?: number; // 0-100
}

const AliceAvatar: React.FC<AliceAvatarProps> = ({ onPoke, onAffectionChange, affection = 50 }) => {
  const [emotion, setEmotion] = useState<AliceEmotion>("normal");
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const [isShaking, setIsShaking] = useState(false);
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  
  // 戳一戳状态
  const [pokeCount, setPokeCount] = useState(0);
  const [pokeMood, setPokeMood] = useState<PokeMood>("happy");
  const [isLockedAngry, setIsLockedAngry] = useState(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const pokeTimeoutRef = useRef<number | null>(null);
  const decayTimeoutRef = useRef<number | null>(null);
  const resetTimeoutRef = useRef<number | null>(null);
  const lastPokeTimeRef = useRef<number>(0);

  // 鼠标追踪 (framer-motion)
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  // 平滑弹簧动画
  const springConfig = { damping: 25, stiffness: 150 };
  const rotateX = useSpring(useTransform(mouseY, [-1, 1], [8, -8]), springConfig);
  const rotateY = useSpring(useTransform(mouseX, [-1, 1], [-8, 8]), springConfig);
  const translateX = useSpring(useTransform(mouseX, [-1, 1], [-6, 6]), springConfig);
  const translateY = useSpring(useTransform(mouseY, [-1, 1], [-6, 6]), springConfig);

  // 预加载图片
  useEffect(() => {
    preloadImages();
  }, []);

  // 监听全局情绪事件 (来自聊天)
  useEffect(() => {
    const handleEmotionEvent = (e: CustomEvent<{ emotion: AliceEmotion; showBubble?: boolean; bubbleText?: string }>) => {
      const newEmotion = e.detail?.emotion;
      if (newEmotion && EMOTION_IMAGE_MAP[newEmotion]) {
        // 如果不是锁定生气状态，允许外部情绪覆盖
        if (!isLockedAngry) {
          setEmotion(newEmotion);
        }
        // 如果有气泡文字
        if (e.detail?.bubbleText) {
          setBubbleText(e.detail.bubbleText);
          setTimeout(() => setBubbleText(null), 3000);
        }
      }
    };

    window.addEventListener("alice:emotion", handleEmotionEvent as EventListener);
    return () => window.removeEventListener("alice:emotion", handleEmotionEvent as EventListener);
  }, [isLockedAngry]);

  // 鼠标移动追踪
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const normalizedX = Math.max(-1, Math.min(1, (e.clientX - centerX) / (window.innerWidth / 2)));
      const normalizedY = Math.max(-1, Math.min(1, (e.clientY - centerY) / (window.innerHeight / 2)));

      mouseX.set(normalizedX);
      mouseY.set(normalizedY);
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [mouseX, mouseY]);

  // 计算当前心情基于戳击次数
  const getMoodByCount = useCallback((count: number): PokeMood => {
    if (count >= POKE_MOOD_PROGRESSION.annoyed.nextThreshold) return "angry";
    if (count >= POKE_MOOD_PROGRESSION.shy.nextThreshold) return "annoyed";
    if (count >= POKE_MOOD_PROGRESSION.happy.nextThreshold) return "shy";
    return "happy";
  }, []);

  // 情绪衰减逻辑
  const startDecayTimer = useCallback(() => {
    // 清除旧定时器
    if (decayTimeoutRef.current) clearTimeout(decayTimeoutRef.current);
    if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);

    // 设置衰减定时器（用内部 tick 避免引用自身导致 TDZ）
    const tick = () => {
      if (isLockedAngry) return;

      setPokeCount((prev) => {
        if (prev <= 0) return 0;
        const next = Math.max(0, prev - 1);
        // 继续递减直到归零
        if (next > 0) {
          decayTimeoutRef.current = window.setTimeout(tick, MOOD_DECAY_MS);
        }
        return next;
      });
    };

    decayTimeoutRef.current = window.setTimeout(tick, MOOD_DECAY_MS);

    // 设置完全重置定时器
    resetTimeoutRef.current = window.setTimeout(() => {
      if (!isLockedAngry) {
        setPokeCount(0);
        setPokeMood("happy");
        setEmotion("normal");
        setBubbleText(null);
      }
    }, MOOD_RESET_MS);
  }, [isLockedAngry]);

  // 戳一戳处理
  const handlePoke = useCallback(() => {
    const now = Date.now();
    
    // 防抖: 500ms 内不响应
    if (now - lastPokeTimeRef.current < 500) return;
    lastPokeTimeRef.current = now;

    // 清除之前的超时
    if (pokeTimeoutRef.current) clearTimeout(pokeTimeoutRef.current);

    // 增加戳击计数
    const newCount = pokeCount + 1;
    setPokeCount(newCount);

    // 计算当前心情
    const newMood = getMoodByCount(newCount);
    setPokeMood(newMood);

    // 获取对应配置
    const moodConfig = POKE_MOOD_PROGRESSION[newMood];
    
    // 设置表情
    setEmotion(moodConfig.emotion);

    // 随机选择气泡文字
    const randomText = moodConfig.bubbleTexts[Math.floor(Math.random() * moodConfig.bubbleTexts.length)];
    setBubbleText(randomText);

    // 触发抖动
    setIsShaking(true);

    // 如果达到生气状态，锁定
    if (newMood === "angry") {
      setIsLockedAngry(true);
      // 好感度扣除
      onAffectionChange?.(-5);
    } else if (newMood === "annoyed") {
      // 烦躁时小扣
      onAffectionChange?.(-1);
    }

    // 触发外部回调
    onPoke?.(newCount, newMood);

    // 2秒后关闭气泡，但不改变表情
    pokeTimeoutRef.current = window.setTimeout(() => {
      setBubbleText(null);
      setIsShaking(false);
    }, 2000);

    // 启动衰减定时器
    startDecayTimer();
  }, [pokeCount, getMoodByCount, onPoke, onAffectionChange, startDecayTimer]);

  // 清理
  useEffect(() => {
    return () => {
      if (pokeTimeoutRef.current) clearTimeout(pokeTimeoutRef.current);
      if (decayTimeoutRef.current) clearTimeout(decayTimeoutRef.current);
      if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    };
  }, []);

  // 重置生气状态的方法（可通过外部事件触发）
  useEffect(() => {
    const handleResetAngry = () => {
      setIsLockedAngry(false);
      setPokeCount(0);
      setPokeMood("happy");
      setEmotion("normal");
    };

    window.addEventListener("alice:resetAngry", handleResetAngry);
    return () => window.removeEventListener("alice:resetAngry", handleResetAngry);
  }, []);

  // 根据好感度获取显示信息
  const getAffectionDisplay = (value: number) => {
    if (value >= 80) return { icon: "💕", label: "亲密", color: "text-pink-500" };
    if (value >= 60) return { icon: "❤️", label: "喜欢", color: "text-red-400" };
    if (value >= 40) return { icon: "💙", label: "友好", color: "text-blue-400" };
    if (value >= 20) return { icon: "💔", label: "冷淡", color: "text-gray-400" };
    return { icon: "🖤", label: "厌恶", color: "text-gray-600" };
  };

  const affectionDisplay = getAffectionDisplay(affection);
  const currentImage = EMOTION_IMAGE_MAP[emotion] || EMOTION_IMAGE_MAP.normal;

  return (
    <motion.div
      ref={containerRef}
      className="relative w-48 h-48 cursor-pointer select-none"
      onClick={handlePoke}
      style={{
        perspective: 1000,
        rotateX,
        rotateY,
        x: translateX,
        y: translateY,
      }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      title="戳一戳 爱丽丝"
    >
      {/* 好感度显示 (左上角) */}
      <motion.div
        className="absolute -top-1 -left-1 z-30"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.3, type: "spring" }}
      >
        <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm rounded-full px-2 py-1 shadow-md border border-gray-200/50 dark:border-gray-600/50 flex items-center gap-1">
          <span className="text-sm">{affectionDisplay.icon}</span>
          <span className={`text-xs font-medium ${affectionDisplay.color}`}>
            {affection}
          </span>
        </div>
      </motion.div>

      {/* 气泡文字 (不是emoji) */}
      <AnimatePresence>
        {bubbleText && (
          <motion.div
            className="absolute -top-12 left-1/2 -translate-x-1/2 z-20 pointer-events-none"
            initial={{ scale: 0, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0, opacity: 0, y: -10 }}
            transition={{ type: "spring", damping: 15 }}
          >
            <div className="relative bg-white dark:bg-gray-800 px-3 py-2 rounded-xl shadow-lg border border-gray-200 dark:border-gray-600 whitespace-nowrap">
              <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
                {bubbleText}
              </span>
              {/* 气泡尖角 */}
              <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[8px] border-l-transparent border-r-[8px] border-r-transparent border-t-[8px] border-t-white dark:border-t-gray-800" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 主图像容器 */}
      <motion.div
        className="w-full h-full relative"
        animate={isShaking ? { 
          x: [0, -5, 5, -5, 5, 0],
          rotate: [0, -2, 2, -2, 2, 0]
        } : {}}
        transition={{ duration: 0.4 }}
      >
        {/* 加载占位 */}
        {!isImageLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-blue-100 to-purple-100 dark:from-blue-900/30 dark:to-purple-900/30 rounded-full">
            <div className="w-12 h-12 border-4 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
          </div>
        )}

        {/* 爱丽丝图像 */}
        <motion.img
          key={currentImage}
          src={currentImage}
          alt={`Alice - ${emotion}`}
          className="w-full h-full aspect-square object-contain drop-shadow-lg"
          style={{
            opacity: isImageLoaded ? 1 : 0,
            transition: "opacity 0.3s ease-in-out",
          }}
          onLoad={() => setIsImageLoaded(true)}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.25 }}
          draggable={false}
        />

        {/* 呼吸光晕效果 */}
        <div 
          className="absolute inset-0 rounded-full pointer-events-none opacity-30"
          style={{
            background: `radial-gradient(circle at 50% 50%, ${
              isLockedAngry 
                ? "rgba(239, 68, 68, 0.4)" 
                : "rgba(96, 165, 250, 0.3)"
            } 0%, transparent 70%)`,
            animation: "pulse 3s ease-in-out infinite",
          }}
        />
      </motion.div>

      {/* 调试信息 (开发环境) */}
      {process.env.NODE_ENV === "development" && (
        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-xs text-gray-500 bg-white/80 dark:bg-gray-800/80 px-2 py-0.5 rounded flex gap-2">
          <span>{emotion}</span>
          <span>x{pokeCount}</span>
          <span className={pokeMood === "angry" ? "text-red-500" : ""}>{pokeMood}</span>
        </div>
      )}
    </motion.div>
  );
};

export default AliceAvatar;

// ============================
// 导出类型供外部使用
// ============================
export { EMOTION_IMAGE_MAP, POKE_MOOD_PROGRESSION };
export type { PokeMood };