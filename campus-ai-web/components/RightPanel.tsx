"use client";

import React from "react";
import { X, Calendar, Cloud, Clock } from "lucide-react";

interface RightPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  currentMode: string;
}

export default function RightPanel({ isOpen, onToggle, currentMode }: RightPanelProps) {
  return (
    <>
      {/* 移动端遮罩层 */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onToggle}
        />
      )}
      
      {/* 右侧面板主体 */}
      <div
        className={`fixed right-0 top-0 h-full bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 transition-transform duration-300 z-50 w-80 shadow-xl ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex flex-col h-full p-4 w-80">
          {/* 标题与关闭按钮 */}
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg text-gray-800 dark:text-gray-100">上下文</h2>
            <button
              onClick={onToggle}
              className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 lg:hidden"
              title="关闭"
            >
              <X size={20} />
            </button>
          </div>

          {/* 上下文卡片 */}
          <div className="space-y-4 flex-1 overflow-y-auto">
            {/* 当前模式卡片 */}
            <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                <span className="text-sm font-medium text-blue-700 dark:text-blue-300">当前模式</span>
              </div>
              <p className="text-lg font-semibold">{currentMode}</p>
            </div>

            {/* 今日课表 */}
            {currentMode === "Class" && (
              <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-3">
                  <Calendar size={16} className="text-gray-500" />
                  <span className="font-medium">今日课表</span>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="p-2 bg-gray-50 dark:bg-gray-900 rounded">
                    <p className="font-medium">08:00 - 09:40</p>
                    <p className="text-gray-600 dark:text-gray-400">高等数学 · A101</p>
                  </div>
                  <div className="p-2 bg-gray-50 dark:bg-gray-900 rounded">
                    <p className="font-medium">14:00 - 15:40</p>
                    <p className="text-gray-600 dark:text-gray-400">计算机网络 · B205</p>
                  </div>
                </div>
              </div>
            )}

            {/* 天气卡片 */}
            {currentMode === "Plan" && (
              <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-3">
                  <Cloud size={16} className="text-gray-500" />
                  <span className="font-medium">今日天气</span>
                </div>
                <div className="text-sm">
                  <p className="text-2xl font-bold">22°C</p>
                  <p className="text-gray-600 dark:text-gray-400">多云 · 空气质量良好</p>
                </div>
              </div>
            )}

            {/* 下一节课 */}
            {currentMode === "Class" && (
              <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-3">
                  <Clock size={16} className="text-gray-500" />
                  <span className="font-medium">下一节课</span>
                </div>
                <div className="text-sm">
                  <p className="font-medium">高等数学</p>
                  <p className="text-gray-600 dark:text-gray-400">还有 1小时30分</p>
                  <p className="text-gray-600 dark:text-gray-400">地点: A101</p>
                </div>
              </div>
            )}

            {/* 建议 */}
            {currentMode === "Ask" && (
              <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-medium">推荐问题</span>
                </div>
                <div className="space-y-2 text-sm">
                  <button className="w-full text-left p-2 hover:bg-gray-50 dark:hover:bg-gray-900 rounded transition-colors">
                    今天有哪些课程？
                  </button>
                  <button className="w-full text-left p-2 hover:bg-gray-50 dark:hover:bg-gray-900 rounded transition-colors">
                    明天天气怎么样？
                  </button>
                  <button className="w-full text-left p-2 hover:bg-gray-50 dark:hover:bg-gray-900 rounded transition-colors">
                    制定本周学习计划
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
