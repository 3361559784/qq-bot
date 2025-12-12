import React, { useState, useEffect } from "react";

// 颜文字情绪库
const KAOMOJI_EMOTIONS = {
  idle: ["(✨ω✨)", "(´･ω･`)", "(｡◕‿◕｡)", "( ´ ▽ ` )"],
  thinking: ["(・ω・)?", "(´-ω-`)?", "( ˘•ω•˘ )?"],
  happy: ["(≧∇≦)/", "(｡♥‿♥｡)", "ヾ(≧▽≦*)o", "(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧"],
  angry: ["(`皿`)", "(╬ಠ益ಠ)", "(¬_¬ )", "ヽ(`Д´)ﾉ"],
  poke: ["(╥﹏╥)", "(｡•́︿•̀｡)", "(っ˘̩╭╮˘̩)っ", "( ˘︹˘ )"]
};

const POKE_CONFIG = {
  angryThreshold: 3,
  rageThreshold: 5,
  cooldownMs: 10000
};

interface EmotionEvent extends CustomEvent {
  detail: {
    emotion: keyof typeof KAOMOJI_EMOTIONS;
    showBubble?: boolean;
  };
}

export default function AliceAvatarEnhanced() {
  const [currentEmotion, setCurrentEmotion] = useState<keyof typeof KAOMOJI_EMOTIONS>("idle");
  const [kaomoji, setKaomoji] = useState(KAOMOJI_EMOTIONS.idle[0]);
  const [showBubble, setShowBubble] = useState(false);
  const [pokeCount, setPokeCount] = useState(0);
  const [lastPokeTime, setLastPokeTime] = useState(0);

  // 监听全局情绪事件
  useEffect(() => {
    const handleEmotionChange = (e: Event) => {
      const event = e as EmotionEvent;
      const { emotion, showBubble: show = true } = event.detail;
      
      setCurrentEmotion(emotion);
      const emotionList = KAOMOJI_EMOTIONS[emotion];
      const randomKaomoji = emotionList[Math.floor(Math.random() * emotionList.length)];
      setKaomoji(randomKaomoji);
      
      if (show) {
        setShowBubble(true);
        setTimeout(() => setShowBubble(false), 2500);
      }
    };

    window.addEventListener("alice:emotion", handleEmotionChange);
    return () => window.removeEventListener("alice:emotion", handleEmotionChange);
  }, []);

  // 戳一戳冷却重置
  useEffect(() => {
    if (pokeCount > 0) {
      const timer = setTimeout(() => {
        setPokeCount(0);
      }, POKE_CONFIG.cooldownMs);
      return () => clearTimeout(timer);
    }
  }, [pokeCount, lastPokeTime]);

  // 点击事件
  const handleClick = () => {
    const now = Date.now();
    
    if (now - lastPokeTime > POKE_CONFIG.cooldownMs) {
      setPokeCount(0);
    }
    
    const newCount = pokeCount + 1;
    setPokeCount(newCount);
    setLastPokeTime(now);

    if (newCount >= POKE_CONFIG.rageThreshold) {
      window.dispatchEvent(new CustomEvent("alice:emotion", {
        detail: { emotion: "angry", showBubble: true }
      }));
    } else if (newCount >= POKE_CONFIG.angryThreshold) {
      window.dispatchEvent(new CustomEvent("alice:emotion", {
        detail: { emotion: "poke", showBubble: true }
      }));
    } else {
      window.dispatchEvent(new CustomEvent("alice:emotion", {
        detail: { emotion: "happy", showBubble: true }
      }));
    }
  };

  const getEmotionClass = () => {
    if (currentEmotion === "thinking") return "animate-pulse";
    if (currentEmotion === "happy") return "animate-bounce";
    if (currentEmotion === "angry") return "shake";
    return "";
  };

  return (
    <div className="relative flex items-center justify-center">
      {/* Alice头像 (简化版 - CSS动画) */}
      <div 
        onClick={handleClick}
        className="relative cursor-pointer group"
      >
        <div className={`w-32 h-32 rounded-full bg-gradient-to-br from-blue-400 via-purple-400 to-pink-400 flex items-center justify-center text-white font-bold text-5xl shadow-lg transition-transform hover:scale-110 ${getEmotionClass()}`}>
          Alice
        </div>
        
        {/* 鼠标悬停提示 */}
        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity text-xs text-gray-500 whitespace-nowrap">
          戳我试试 (✨ω✨)
        </div>
      </div>

      {/* 颜文字气泡 */}
      {showBubble && (
        <div className="absolute -top-16 left-1/2 -translate-x-1/2 bg-white dark:bg-gray-800 px-4 py-2 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700">
          <div className="text-2xl">{kaomoji}</div>
          <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-0 h-0 border-l-8 border-l-transparent border-r-8 border-r-transparent border-t-8 border-t-white dark:border-t-gray-800"></div>
        </div>
      )}
    </div>
  );
}
