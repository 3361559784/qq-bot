"use client";

import React from "react";
import { motion } from "framer-motion";

interface ThinkingAnimationProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * 简化版思考动画组件
 * - breathing: ChatGPT 风格呼吸式小圆圈 (默认)
 * - dots: 跳动的点点
 */
const ThinkingAnimation: React.FC<ThinkingAnimationProps> = ({
  size = "md",
  className = "",
}) => {
  const sizeMap = {
    sm: 22,
    md: 28,
    lg: 36,
  };
  const circleSize = sizeMap[size];

  // 呼吸式小圆点 (ChatGPT 风格)
  return (
    <div
      className={`relative flex items-center justify-center ${className}`}
      style={{ width: circleSize, height: circleSize }}
    >
      <motion.div
        className="absolute inset-0 rounded-full bg-gradient-to-br from-blue-400 to-blue-600"
        animate={{
          scale: [1, 1.22, 1],
          opacity: [0.25, 0.55, 0.25],
        }}
        transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="relative rounded-full bg-white/85 dark:bg-white/70"
        style={{ width: Math.max(6, Math.round(circleSize * 0.28)), height: Math.max(6, Math.round(circleSize * 0.28)) }}
        animate={{
          scale: [1, 1.35, 1],
          opacity: [0.7, 1, 0.7],
        }}
        transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
};

export default ThinkingAnimation;
