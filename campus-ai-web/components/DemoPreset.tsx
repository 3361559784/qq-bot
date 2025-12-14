"use client";

import React from "react";
import { Zap, Calendar, MessageCircle, Search, Sparkles } from "lucide-react";

// 预设的 Demo 课表数据（评委作弊码）
export const DEMO_SCHEDULE = [
  { courseName: "高等数学（一）", instructor: "张教授", location: "A01-301", weekday: 1, startTime: "08:00", endTime: "09:35", weeks: "1-16" },
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 1, startTime: "10:00", endTime: "11:35", weeks: "1-16" },
  { courseName: "程序设计基础", instructor: "李老师", location: "B03-502", weekday: 2, startTime: "08:00", endTime: "09:35", weeks: "1-16" },
  { courseName: "线性代数", instructor: "王教授", location: "A02-101", weekday: 2, startTime: "14:00", endTime: "15:35", weeks: "1-16" },
  { courseName: "大学物理", instructor: "陈老师", location: "C01-201", weekday: 3, startTime: "10:00", endTime: "11:35", weeks: "1-16" },
  { courseName: "思想政治理论", instructor: "刘教授", location: "D02-301", weekday: 3, startTime: "14:00", endTime: "15:35", weeks: "1-16" },
  { courseName: "数据结构", instructor: "赵老师", location: "B03-401", weekday: 4, startTime: "08:00", endTime: "09:35", weeks: "1-16" },
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 4, startTime: "10:00", endTime: "11:35", weeks: "1-16" },
  { courseName: "高等数学（一）", instructor: "张教授", location: "A01-301", weekday: 5, startTime: "08:00", endTime: "09:35", weeks: "1-16" },
  { courseName: "体育", instructor: "体育组", location: "操场", weekday: 5, startTime: "14:00", endTime: "15:35", weeks: "1-16" },
];

// 预设的 Demo 问题
export const DEMO_QUESTIONS = [
  { mode: "Class", question: "下一节课是什么", icon: Calendar, label: "查课程" },
  { mode: "Class", question: "今天有什么课", icon: Calendar, label: "今日课表" },
  { mode: "Class", question: "明天有课吗", icon: Calendar, label: "明日安排" },
  { mode: "Plan", question: "帮我安排今天的学习计划", icon: Sparkles, label: "生成计划" },
  { mode: "Search", question: "搜索 量子力学", icon: Search, label: "联网搜索" },
  { mode: "Ask", question: "你好，介绍一下你自己", icon: MessageCircle, label: "日常聊天" },
];

interface DemoPresetProps {
  onLoadSchedule: (schedule: typeof DEMO_SCHEDULE) => void;
  onSendQuestion: (mode: string, question: string) => void;
  hasSchedule: boolean;
}

export default function DemoPreset({ onLoadSchedule, onSendQuestion, hasSchedule }: DemoPresetProps) {
  return (
    <div className="bg-gradient-to-br from-yellow-50 to-orange-50 dark:from-yellow-900/20 dark:to-orange-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl p-4 mb-6">
      {/* 标题 */}
      <div className="flex items-center gap-2 mb-3">
        <Zap size={18} className="text-yellow-600" />
        <span className="font-semibold text-yellow-800 dark:text-yellow-200">Demo 快捷操作</span>
        <span className="text-xs text-yellow-600 dark:text-yellow-400">（评委专用）</span>
      </div>

      {/* 一键导入课表 */}
      {!hasSchedule && (
        <button
          onClick={() => onLoadSchedule(DEMO_SCHEDULE)}
          className="w-full mb-3 px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-white rounded-lg font-medium transition-all flex items-center justify-center gap-2 shadow-sm"
        >
          <Calendar size={16} />
          一键导入示例课表（10门课）
        </button>
      )}

      {hasSchedule && (
        <div className="mb-3 px-3 py-2 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-lg text-sm flex items-center gap-2">
          ✅ 课表已就绪，可以开始演示
        </div>
      )}

      {/* 快捷问题按钮 */}
      <div className="grid grid-cols-3 gap-2">
        {DEMO_QUESTIONS.map((q, idx) => {
          const Icon = q.icon;
          return (
            <button
              key={idx}
              onClick={() => onSendQuestion(q.mode, q.question)}
              className="px-3 py-2 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-300 transition-colors flex items-center gap-1.5"
              title={q.question}
            >
              <Icon size={12} />
              {q.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
