"use client";

import React from "react";
import { MapPin, BookOpen, Coffee, Moon, Sparkles } from "lucide-react";

// 计划项目类型
export interface PlanItem {
  time: string;           // "08:00-09:35"
  type: "class" | "study" | "break" | "review";
  title: string;          // "上课：《大学英语》" or "自习时间"
  location?: string;      // "E02-207"
  suggestion?: string;    // "推荐复习"
}

export interface DayPlan {
  day: string;            // "周一" or "周日（今天）"
  isToday: boolean;
  items: PlanItem[];
}

interface PlanCardProps {
  plan: DayPlan[];
  title?: string;
}

const typeConfig = {
  class: { icon: BookOpen, color: "bg-blue-500", label: "上课" },
  study: { icon: Sparkles, color: "bg-purple-500", label: "自习" },
  break: { icon: Coffee, color: "bg-green-500", label: "休息" },
  review: { icon: Moon, color: "bg-orange-500", label: "复习" },
};

export default function PlanCard({ plan, title = "学习计划" }: PlanCardProps) {
  if (!plan || plan.length === 0) {
    return (
      <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 text-center text-gray-500">
        暂无计划数据
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
      {/* 标题 */}
      <div className="px-4 py-3 bg-gradient-to-r from-blue-500 to-purple-500 text-white">
        <h3 className="font-semibold flex items-center gap-2">
          <Sparkles size={18} />
          {title}
        </h3>
      </div>

      {/* 每日计划 */}
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {plan.map((dayPlan, dayIdx) => (
          <div key={dayIdx} className="p-4">
            {/* 日期标题 */}
            <div className={`text-sm font-semibold mb-3 ${
              dayPlan.isToday 
                ? "text-blue-600 dark:text-blue-400" 
                : "text-gray-600 dark:text-gray-400"
            }`}>
              {dayPlan.day}
              {dayPlan.isToday && (
                <span className="ml-2 px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-xs rounded-full">
                  今天
                </span>
              )}
            </div>

            {/* 时间线 */}
            <div className="space-y-2">
              {dayPlan.items.map((item, itemIdx) => {
                const config = typeConfig[item.type] || typeConfig.study;
                const Icon = config.icon;

                return (
                  <div 
                    key={itemIdx}
                    className="flex items-start gap-3 p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                  >
                    {/* 时间 */}
                    <div className="w-24 flex-shrink-0 text-xs text-gray-500 dark:text-gray-400 font-mono pt-0.5">
                      {item.time}
                    </div>

                    {/* 图标 */}
                    <div className={`w-6 h-6 rounded-full ${config.color} flex items-center justify-center flex-shrink-0`}>
                      <Icon size={12} className="text-white" />
                    </div>

                    {/* 内容 */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                        {item.title}
                      </div>
                      {item.location && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1 mt-0.5">
                          <MapPin size={10} />
                          {item.location}
                        </div>
                      )}
                      {item.suggestion && (
                        <div className="text-xs text-purple-500 dark:text-purple-400 mt-0.5">
                          💡 {item.suggestion}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 底部提示 */}
      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 text-center">
        ✨ 坚持就是胜利，加油！
      </div>
    </div>
  );
}

/**
 * 解析 Markdown 格式的计划文本为结构化数据
 */
export function parsePlanText(text: string): DayPlan[] {
  const lines = text.split('\n');
  const plans: DayPlan[] = [];
  let currentDay: DayPlan | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    
    // 跳过标题和空行
    if (!trimmed || trimmed.startsWith('📚') || trimmed.startsWith('✨')) continue;

    // 检测日期行：**周一** 或 **周日（今天）**
    const dayMatch = trimmed.match(/^\*\*(周[一二三四五六日])(?:（(今天)）)?\*\*$/);
    if (dayMatch) {
      if (currentDay) plans.push(currentDay);
      currentDay = {
        day: dayMatch[1],
        isToday: dayMatch[2] === '今天',
        items: []
      };
      continue;
    }

    // 检测时间项：- 08:00-09:35 内容
    const itemMatch = trimmed.match(/^-\s*(\d{2}:\d{2})-(\d{2}:\d{2})\s+(.+)$/);
    if (itemMatch && currentDay) {
      const timeRange = `${itemMatch[1]}-${itemMatch[2]}`;
      const content = itemMatch[3];
      
      let type: PlanItem["type"] = "study";
      const title = content;
      let location: string | undefined;
      let suggestion: string | undefined;

      // 解析类型
      if (content.includes('上课')) {
        type = "class";
        // 提取位置 @E02-207
        const locMatch = content.match(/@([^\s]+)/);
        if (locMatch) location = locMatch[1];
      } else if (content.includes('复习') || content.includes('推荐复习')) {
        type = "review";
        suggestion = content.includes('推荐') ? content.replace(/^-\s*/, '') : undefined;
      } else if (content.includes('休息')) {
        type = "break";
      }

      currentDay.items.push({ time: timeRange, type, title, location, suggestion });
      continue;
    }

    // 简单项：- 全天空闲，建议自习或复习
    const simpleMatch = trimmed.match(/^-\s+(.+)$/);
    if (simpleMatch && currentDay) {
      const content = simpleMatch[1];
      
      let type: PlanItem["type"] = "study";
      if (content.includes('复习') || content.includes('推荐复习')) type = "review";
      if (content.includes('休息')) type = "break";

      currentDay.items.push({ 
        time: "全天", 
        type, 
        title: content,
        suggestion: content.includes('推荐') ? content : undefined
      });
    }
  }

  if (currentDay) plans.push(currentDay);
  
  return plans;
}
