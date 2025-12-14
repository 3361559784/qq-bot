"use client";

import React, { useState } from "react";
import { 
  Sparkles, X, Calendar, FileSpreadsheet, FileText, 
  Image, Edit3, Link, CheckCircle,
  Download, Eye
} from "lucide-react";

// 严乐的真实课表数据（完整版 - 27门课程）
export const JUDGE_DEMO_SCHEDULE = [
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 1, startTime: "08:00", endTime: "09:40", weeks: "7-16周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "E03-A308", weekday: 1, startTime: "10:00", endTime: "11:40", weeks: "7-8周" },
  { courseName: "思想道德与法治", instructor: "严碧云", location: "E03-A308", weekday: 1, startTime: "14:00", endTime: "15:40", weeks: "7-15周" },
  { courseName: "形势与政策", instructor: "余胜任", location: "E03-A415", weekday: 1, startTime: "15:55", endTime: "17:30", weeks: "8-11周" },
  { courseName: "劳动教育", instructor: "严碧云", location: "E02-203", weekday: 1, startTime: "19:00", endTime: "20:40", weeks: "11-14周" },
  { courseName: "大学语文", instructor: "陶晓辉", location: "E02-105", weekday: 2, startTime: "08:00", endTime: "09:40", weeks: "7-13周" },
  { courseName: "军事理论", instructor: "高玮", location: "线上教学", weekday: 2, startTime: "10:00", endTime: "11:40", weeks: "8-13周" },
  { courseName: "大学体育（一）—跆拳道", instructor: "叶鹏飞", location: "T01-104", weekday: 2, startTime: "10:00", endTime: "11:40", weeks: "8-14周" },
  { courseName: "思想道德与法治", instructor: "严碧云", location: "E03-A412", weekday: 2, startTime: "14:00", endTime: "15:40", weeks: "7-15周" },
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 3, startTime: "08:00", endTime: "09:40", weeks: "7周,9周,11周,13周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "E03-A308", weekday: 3, startTime: "10:00", endTime: "11:40", weeks: "7-8周" },
  { courseName: "计算机应用基础项目式实践", instructor: "许骏", location: "S4-202", weekday: 3, startTime: "14:00", endTime: "15:40", weeks: "7周,10-15周" },
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 3, startTime: "15:55", endTime: "17:30", weeks: "7-16周" },
  { courseName: "计算机应用基础项目式实践", instructor: "许骏", location: "S4-202", weekday: 4, startTime: "10:00", endTime: "11:40", weeks: "7周,10-15周" },
  { courseName: "机械工程制图（一）", instructor: "宋长贵", location: "E03-A409", weekday: 4, startTime: "14:00", endTime: "15:40", weeks: "6-7周,9-17周" },
  { courseName: "大学体育（一）—跆拳道", instructor: "叶鹏飞", location: "T01-104", weekday: 4, startTime: "15:55", endTime: "17:30", weeks: "6-17周" },
  { courseName: "中华优秀传统文化", instructor: "李洁", location: "线上教学", weekday: 4, startTime: "19:00", endTime: "20:40", weeks: "6-14周" },
  { courseName: "机械工程制图（一）", instructor: "宋长贵", location: "E03-A409", weekday: 5, startTime: "08:00", endTime: "09:40", weeks: "6-17周" },
  { courseName: "大学语文", instructor: "陶晓辉", location: "E02-105", weekday: 5, startTime: "10:00", endTime: "11:40", weeks: "6-7周,9-14周" },
  { courseName: "大学生心理健康教育", instructor: "刘华", location: "E02-605", weekday: 5, startTime: "14:00", endTime: "15:40", weeks: "6-7周,9-14周" },
  { courseName: "职业生涯规划与就业指导（一）", instructor: "严碧云", location: "E03-A308", weekday: 5, startTime: "19:00", endTime: "20:40", weeks: "6-7周,9-14周" },
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A108", weekday: 6, startTime: "08:00", endTime: "09:40", weeks: "7-9周,10-17周" },
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A514", weekday: 6, startTime: "10:00", endTime: "11:40", weeks: "7-18周" },
  { courseName: "劳动教育", instructor: "严碧云", location: "E02-203", weekday: 6, startTime: "14:00", endTime: "15:40", weeks: "7-10周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "线上教学", weekday: 6, startTime: "14:00", endTime: "15:40", weeks: "7-8周" },
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 6, startTime: "15:55", endTime: "17:30", weeks: "8周,10周,12周,14周" },
  { courseName: "工程训练（一）", instructor: "钱程", location: "E01-104", weekday: 6, startTime: "19:00", endTime: "20:40", weeks: "6-12周" },
];

const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const SUPPORTED_FORMATS = [
  { icon: Link, name: "学习通链接", desc: "直接粘贴超星学习通课表分享链接", status: "✅" },
  { icon: FileSpreadsheet, name: "Excel 文件", desc: "支持 .xlsx / .xls 格式", status: "✅" },
  { icon: FileText, name: "ICS 日历", desc: "标准 iCalendar 格式", status: "✅" },
  { icon: Image, name: "图片 OCR", desc: "Azure Vision API 智能识别", status: "✅" },
  { icon: Edit3, name: "手动输入", desc: "表单式逐条添加", status: "✅" },
];

interface JudgePanelProps {
  onLoadSchedule: (schedule: typeof JUDGE_DEMO_SCHEDULE) => void;
  onClearSchedule?: () => void;
  currentSchedule: typeof JUDGE_DEMO_SCHEDULE;
}

export default function JudgePanel({ onLoadSchedule, onClearSchedule, currentSchedule }: JudgePanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const handleLoadSchedule = () => {
    onLoadSchedule(JUDGE_DEMO_SCHEDULE);
    setIsOpen(false);
  };

  const handleClearSchedule = () => {
    // 清除 localStorage 中的课表
    if (typeof window !== 'undefined') {
      localStorage.removeItem('campus_schedule');
      localStorage.removeItem('campus_curriculum_uuid');
    }
    onClearSchedule?.();
  };

  return (
    <>
      {/* 悬浮按钮 */}
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-40 px-4 py-3 bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 text-white rounded-full shadow-lg hover:shadow-xl transition-all flex items-center gap-2 font-medium"
      >
        <Sparkles size={18} />
        评委面板
      </button>

      {/* 模态框 */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden">
            {/* Header */}
            <div className="bg-gradient-to-r from-yellow-500 to-orange-500 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Sparkles className="text-white" size={24} />
                <div>
                  <h2 className="text-xl font-bold text-white">评委专用面板</h2>
                  <p className="text-yellow-100 text-sm">Microsoft Imagine Cup 2026</p>
                </div>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="p-2 hover:bg-white/20 rounded-full transition-colors"
              >
                <X className="text-white" size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto max-h-[calc(90vh-200px)]">
              {/* 支持的格式 */}
              <div className="mb-6">
                <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                  <Calendar size={18} />
                  支持的课表导入格式
                </h3>
                <div className="grid gap-2">
                  {SUPPORTED_FORMATS.map((format, idx) => {
                    const Icon = format.icon;
                    return (
                      <div
                        key={idx}
                        className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                      >
                        <Icon size={18} className="text-blue-500 flex-shrink-0" />
                        <div className="flex-1">
                          <span className="font-medium text-gray-900 dark:text-white">{format.name}</span>
                          <span className="text-gray-500 dark:text-gray-400 text-sm ml-2">{format.desc}</span>
                        </div>
                        <span className="text-green-500">{format.status}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 一键导入 */}
              <div className="mb-6">
                <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                  <CheckCircle size={18} className="text-green-500" />
                  一键导入示例课表
                </h3>
                <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl">
                  <p className="text-sm text-green-700 dark:text-green-300 mb-3">
                    这是一份<strong>真实大学生课表</strong>（2025-2026学年第一学期），包含 <strong>{JUDGE_DEMO_SCHEDULE.length} 门课程</strong>，
                    涵盖周一至周六的完整安排。
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={handleLoadSchedule}
                      className="flex-1 py-3 bg-green-500 hover:bg-green-600 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
                    >
                      <Calendar size={18} />
                      一键导入课表（{JUDGE_DEMO_SCHEDULE.length}门课）
                    </button>
                    <button
                      onClick={() => setShowPreview(!showPreview)}
                      className="px-4 py-3 border border-green-500 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/30 rounded-lg font-medium transition-colors flex items-center gap-2"
                    >
                      <Eye size={18} />
                      {showPreview ? "隐藏" : "预览"}
                    </button>
                  </div>
                </div>
              </div>

              {/* 课表预览 */}
              {showPreview && (
                <div className="mb-6">
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                    <Eye size={18} />
                    课表数据预览（本周视图）
                  </h3>
                  <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                    <div className="max-h-96 overflow-y-auto">
                      {/* 按天分组显示 */}
                      {[1, 2, 3, 4, 5, 6, 7].map(weekday => {
                        const dayCourses = JUDGE_DEMO_SCHEDULE.filter(c => c.weekday === weekday)
                          .sort((a, b) => a.startTime.localeCompare(b.startTime));
                        if (dayCourses.length === 0) return null;
                        
                        // 计算本周该天的具体日期
                        const now = new Date();
                        const currentWeekday = now.getDay() === 0 ? 7 : now.getDay();
                        const diff = weekday - currentWeekday;
                        const targetDate = new Date(now);
                        targetDate.setDate(now.getDate() + diff);
                        const dateStr = `${targetDate.getMonth() + 1}月${targetDate.getDate()}日`;
                        const isToday = diff === 0;
                        const isTomorrow = diff === 1;
                        
                        return (
                          <div key={weekday} className="border-b border-gray-100 dark:border-gray-800 last:border-b-0">
                            <div className={`px-3 py-2 font-medium flex items-center gap-2 ${
                              isToday 
                                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' 
                                : isTomorrow 
                                  ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                                  : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                            }`}>
                              <span>{WEEKDAY_NAMES[weekday]}</span>
                              <span className="text-sm opacity-70">{dateStr}</span>
                              {isToday && <span className="text-xs px-1.5 py-0.5 bg-blue-500 text-white rounded">今天</span>}
                              {isTomorrow && <span className="text-xs px-1.5 py-0.5 bg-green-500 text-white rounded">明天</span>}
                            </div>
                            <table className="w-full text-sm">
                              <tbody>
                                {dayCourses.map((course, idx) => (
                                  <tr key={idx} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                    <td className="px-3 py-2 text-gray-600 dark:text-gray-400 w-24">{course.startTime}-{course.endTime}</td>
                                    <td className="px-3 py-2 text-gray-900 dark:text-white font-medium">{course.courseName}</td>
                                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{course.location}</td>
                                    <td className="px-3 py-2 text-gray-400 dark:text-gray-500 text-xs">{course.instructor}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    共 {JUDGE_DEMO_SCHEDULE.length} 门课程 · 数据来源：严乐 2024-2025学年第一学期真实课表
                  </p>
                </div>
              )}

              {/* 标准命令提示 */}
              <div className="mb-6">
                <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                  <span className="text-lg">🎯</span>
                  爱丽丝可以做什么？
                </h3>
                <div className="grid gap-2">
                  <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                    <p className="font-medium text-blue-700 dark:text-blue-300 mb-1">📅 课表查询</p>
                    <p className="text-sm text-blue-600 dark:text-blue-400">「今天有什么课？」「明天有什么课？」「下一节课是什么？」「高等数学什么时候上？」</p>
                  </div>
                  <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                    <p className="font-medium text-green-700 dark:text-green-300 mb-1">📚 课表导入</p>
                    <p className="text-sm text-green-600 dark:text-green-400">支持学习通链接、Excel、ICS日历、图片OCR、手动输入 5种方式</p>
                  </div>
                  <div className="p-3 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg">
                    <p className="font-medium text-purple-700 dark:text-purple-300 mb-1">💬 人格化闲聊</p>
                    <p className="text-sm text-purple-600 dark:text-purple-400">「爱丽丝，你在干嘛？」「今天天气怎么样？」「讲个笑话」（戳头像互动）</p>
                  </div>
                  <div className="p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
                    <p className="font-medium text-orange-700 dark:text-orange-300 mb-1">🔍 搜索功能</p>
                    <p className="text-sm text-orange-600 dark:text-orange-400">「帮我搜索 xxx」「查一下 yyy」</p>
                  </div>
                  <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                    <p className="font-medium text-red-700 dark:text-red-300 mb-1">⚠️ 红线意识演示</p>
                    <p className="text-sm text-red-600 dark:text-red-400">清除课表后问「今天有什么课？」→ AI 拒绝幻觉，引导导入</p>
                  </div>
                </div>
              </div>

              {/* 当前状态 */}
              <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-xl">
                <h3 className="font-semibold text-gray-900 dark:text-white mb-2">当前状态</h3>
                {currentSchedule.length > 0 ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                      <CheckCircle size={18} />
                      <span>已导入 {currentSchedule.length} 门课程，可以开始查询</span>
                    </div>
                    <button
                      onClick={handleClearSchedule}
                      className="text-sm px-3 py-1 text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                    >
                      🗑️ 清除课表（测试红线意识）
                    </button>
                  </div>
                ) : (
                  <div className="text-gray-500 dark:text-gray-400">
                    尚未导入课表，点击上方按钮一键导入
                  </div>
                )}
              </div>

              {/* 下载示例文件 */}
              <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                  <Download size={18} />
                  下载示例文件（验证解析能力）
                </h3>
                <div className="flex gap-3">
                  <a
                    href="/api/demo/schedule.xlsx"
                    className="flex-1 py-2 px-4 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 transition-colors flex items-center justify-center gap-2"
                  >
                    <FileSpreadsheet size={16} />
                    Excel 格式
                  </a>
                  <a
                    href="/api/demo/schedule.ics"
                    className="flex-1 py-2 px-4 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 transition-colors flex items-center justify-center gap-2"
                  >
                    <FileText size={16} />
                    ICS 格式
                  </a>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
              <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
                Built by <strong>ZiHeng Liu</strong> for Microsoft Imagine Cup 2026
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
