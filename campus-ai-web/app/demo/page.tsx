"use client";

import React, { useState, useEffect } from "react";
import { Play, Upload, MessageCircle, CheckCircle, AlertTriangle, Sparkles, ArrowRight, Download, Sun, Moon } from "lucide-react";

// 严乐的真实课表数据
const DEMO_SCHEDULE = [
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 1, startTime: "08:00", endTime: "09:40", weeks: "7-16周" },
  { courseName: "智能制造概论", instructor: "张向阳", location: "E03-A308", weekday: 1, startTime: "10:00", endTime: "11:40", weeks: "7-8周" },
  { courseName: "思想道德与法治", instructor: "严碧云", location: "E03-A308", weekday: 1, startTime: "14:00", endTime: "15:40", weeks: "7-15周" },
  { courseName: "形势与政策", instructor: "余胜任", location: "E03-A415", weekday: 1, startTime: "15:55", endTime: "17:30", weeks: "8-11周" },
  { courseName: "劳动教育", instructor: "严碧云", location: "E02-203", weekday: 1, startTime: "19:00", endTime: "20:40", weeks: "11-14周" },
  { courseName: "大学语文", instructor: "陶晓辉", location: "E02-105", weekday: 2, startTime: "08:00", endTime: "09:40", weeks: "7-13周" },
  { courseName: "大学体育（一）—跆拳道", instructor: "叶鹏飞", location: "T01-104", weekday: 2, startTime: "10:00", endTime: "11:40", weeks: "8-14周" },
  { courseName: "思想道德与法治", instructor: "严碧云", location: "E03-A412", weekday: 2, startTime: "14:00", endTime: "15:40", weeks: "7-15周" },
  { courseName: "大学英语（一）", instructor: "汪玲", location: "E02-207", weekday: 3, startTime: "15:55", endTime: "17:30", weeks: "7-16周" },
  { courseName: "计算机应用基础项目式实践", instructor: "许骏", location: "S4-202", weekday: 4, startTime: "10:00", endTime: "11:40", weeks: "7周,10-15周" },
  { courseName: "机械工程制图（一）", instructor: "宋长贵", location: "E03-A409", weekday: 4, startTime: "14:00", endTime: "15:40", weeks: "6-7周,9-17周" },
  { courseName: "大学体育（一）—跆拳道", instructor: "叶鹏飞", location: "T01-104", weekday: 4, startTime: "15:55", endTime: "17:30", weeks: "6-17周" },
  { courseName: "机械工程制图（一）", instructor: "宋长贵", location: "E03-A409", weekday: 5, startTime: "08:00", endTime: "09:40", weeks: "6-17周" },
  { courseName: "大学语文", instructor: "陶晓辉", location: "E02-105", weekday: 5, startTime: "10:00", endTime: "11:40", weeks: "6-7周,9-14周" },
  { courseName: "大学生心理健康教育", instructor: "刘华", location: "E02-605", weekday: 5, startTime: "14:00", endTime: "15:40", weeks: "6-7周,9-14周" },
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A108", weekday: 6, startTime: "08:00", endTime: "09:40", weeks: "7-9周,10-17周" },
  { courseName: "高等数学（一）", instructor: "陆捷", location: "E03-A514", weekday: 6, startTime: "10:00", endTime: "11:40", weeks: "7-18周" },
];

const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// 推荐问题
const DEMO_QUESTIONS = [
  { text: "今天有什么课？", icon: "📅" },
  { text: "明天有什么课？", icon: "📆" },
  { text: "下一节课是什么？", icon: "⏰" },
  { text: "高等数学什么时候上？", icon: "📐" },
  { text: "爱丽丝，你在干嘛？", icon: "💬" },
];

export default function DemoPage() {
  const [hasSchedule, setHasSchedule] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // 初始化主题
  useEffect(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') {
      setTheme(saved);
    } else {
      const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
      setTheme(prefersDark ? 'dark' : 'light');
    }
  }, []);

  // 应用主题
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  // 加载示例课表
  const loadDemoSchedule = () => {
    localStorage.setItem("campus_schedule", JSON.stringify({
      schedule: DEMO_SCHEDULE,
      source: "demo",
      timestamp: new Date().toISOString()
    }));
    setHasSchedule(true);
    setCurrentStep(3);
    setMessages([{
      role: "assistant",
      content: "📚 示例课表已加载！现在你可以问我课程相关的问题了。\n\n试试问：「明天有什么课？」或「高等数学什么时候上？」"
    }]);
  };

  // 清除课表
  const clearSchedule = () => {
    localStorage.removeItem("campus_schedule");
    setHasSchedule(false);
    setCurrentStep(1);
    setMessages([]);
  };

  // 发送消息
  const sendMessage = async (text: string) => {
    if (!text.trim()) return;
    
    const userMessage = { role: "user", content: text };
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          mode: "Ask",
          history: messages.slice(-6),
        }),
      });

      const data = await response.json();
      setMessages(prev => [...prev, { role: "assistant", content: data.reply || data.error || "抱歉，出了点问题" }]);
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "网络错误，请稍后重试" }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Sparkles className="text-white" size={20} />
            </div>
            <div>
              <h1 className="font-bold text-lg text-gray-900 dark:text-white">Campus Copilot</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">Microsoft Imagine Cup 2026 Demo</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* 主题切换按钮 */}
            <button
              onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors text-gray-500 dark:text-gray-400"
              title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
            >
              {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            <a 
              href="/"
              className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
            >
              进入完整版 <ArrowRight size={14} />
            </a>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-6 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            不是更聪明的 AI，是更懂边界的 AI
          </h2>
        </div>

        {/* Demo Steps */}
        <div className="grid md:grid-cols-3 gap-6 mb-12">
          {/* Step 1 */}
          <div className={`p-6 rounded-2xl border-2 transition-all ${
            currentStep === 1 
              ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30" 
              : currentStep > 1 
                ? "border-green-500 bg-green-50 dark:bg-green-900/30"
                : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
          }`}>
            <div className="flex items-center gap-3 mb-4">
              {currentStep > 1 ? (
                <CheckCircle className="text-green-500" size={24} />
              ) : (
                <div className="w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-bold">1</div>
              )}
              <h3 className="font-semibold text-gray-900 dark:text-white">无课表状态</h3>
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
              体验 AI 在没有数据时的<strong className="text-red-600 dark:text-red-400">红线意识</strong>——拒绝幻觉，引导用户导入数据。
            </p>
            {currentStep === 1 && (
              <button
                onClick={() => {
                  setCurrentStep(2);
                  setMessages([{
                    role: "user",
                    content: "今天有什么课？"
                  }, {
                    role: "assistant", 
                    content: "⚠️ 我还没有你的课表数据。\n\n请先发送学习通课表链接，或上传官方导出的 Excel/ICS，或发送课表截图让我 OCR 解析。\n\n👉 点击下方「加载示例课表」体验完整功能"
                  }]);
                }}
                className="w-full py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg flex items-center justify-center gap-2 transition-colors"
              >
                <AlertTriangle size={16} />
                测试无数据查询
              </button>
            )}
          </div>

          {/* Step 2 */}
          <div className={`p-6 rounded-2xl border-2 transition-all ${
            currentStep === 2 
              ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30" 
              : currentStep > 2 
                ? "border-green-500 bg-green-50 dark:bg-green-900/30"
                : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
          }`}>
            <div className="flex items-center gap-3 mb-4">
              {currentStep > 2 ? (
                <CheckCircle className="text-green-500" size={24} />
              ) : (
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold ${
                  currentStep >= 2 ? "bg-blue-500 text-white" : "bg-gray-300 dark:bg-gray-600 text-gray-600 dark:text-gray-300"
                }`}>2</div>
              )}
              <h3 className="font-semibold text-gray-900 dark:text-white">导入课表</h3>
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
              一键加载<strong className="text-green-600 dark:text-green-400">真实学生课表</strong>（17门课程），体验多源数据导入能力。
            </p>
            {currentStep === 2 && (
              <button
                onClick={loadDemoSchedule}
                className="w-full py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg flex items-center justify-center gap-2 transition-colors"
              >
                <Upload size={16} />
                加载示例课表
              </button>
            )}
          </div>

          {/* Step 3 */}
          <div className={`p-6 rounded-2xl border-2 transition-all ${
            currentStep === 3 
              ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30" 
              : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
          }`}>
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold ${
                currentStep >= 3 ? "bg-blue-500 text-white" : "bg-gray-300 dark:bg-gray-600 text-gray-600 dark:text-gray-300"
              }`}>3</div>
              <h3 className="font-semibold text-gray-900 dark:text-white">智能对话</h3>
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
              体验精确的课表查询和<strong className="text-blue-600 dark:text-blue-400">人格化闲聊</strong>的无缝切换。
            </p>
            {currentStep === 3 && (
              <a
                href="/?demo=true"
                className="w-full py-2 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white rounded-lg flex items-center justify-center gap-2 transition-colors"
              >
                <ArrowRight size={16} />
                进入完整版体验
              </a>
            )}
          </div>
        </div>

        {/* Chat Area */}
        <div className="grid md:grid-cols-3 gap-6">
          {/* Chat Messages */}
          <div className="md:col-span-2 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            {/* Messages */}
            <div className="h-96 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 ? (
                <div className="h-full flex items-center justify-center text-gray-400">
                  <p>点击上方步骤开始体验 👆</p>
                </div>
              ) : (
                messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role !== "user" && (
                      <img src="/images/aris_normal.png" alt="Aris" className="w-8 h-8 rounded-full mr-2 flex-shrink-0" />
                    )}
                    <div className={`max-w-[80%] rounded-2xl px-4 py-2 whitespace-pre-wrap ${
                      msg.role === "user" 
                        ? "bg-blue-500 text-white rounded-tr-sm" 
                        : "bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-tl-sm"
                    }`}>
                      {msg.content}
                    </div>
                  </div>
                ))
              )}
              {isLoading && (
                <div className="flex justify-start">
                  <img src="/images/aris_normal.png" alt="Aris" className="w-8 h-8 rounded-full mr-2" />
                  <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl rounded-tl-sm px-4 py-2">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Input */}
            <div className="border-t border-gray-200 dark:border-gray-700 p-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !isLoading && sendMessage(input)}
                  placeholder={hasSchedule ? "问我任何课程相关的问题..." : "请先完成上方步骤..."}
                  disabled={!hasSchedule || isLoading}
                  className="flex-1 px-4 py-2 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-700 disabled:opacity-50"
                />
                <button
                  onClick={() => sendMessage(input)}
                  disabled={!hasSchedule || isLoading || !input.trim()}
                  className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded-xl transition-colors"
                >
                  <MessageCircle size={20} />
                </button>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Quick Questions */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2 text-gray-900 dark:text-white">
                <MessageCircle size={16} />
                推荐问题
              </h3>
              <div className="space-y-2">
                {DEMO_QUESTIONS.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => hasSchedule && sendMessage(q.text)}
                    disabled={!hasSchedule}
                    className="w-full text-left px-3 py-2 bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 disabled:opacity-50 rounded-lg text-sm transition-colors flex items-center gap-2"
                  >
                    <span>{q.icon}</span>
                    <span>{q.text}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Schedule Preview */}
            {hasSchedule && (
              <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-4">
                <h3 className="font-semibold mb-3 flex items-center gap-2 text-gray-900 dark:text-white">
                  <CheckCircle size={16} className="text-green-500" />
                  已加载课表
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                  {DEMO_SCHEDULE.length} 门课程
                </p>
                <div className="max-h-40 overflow-y-auto text-xs space-y-1">
                  {[1,2,3,4,5,6].map(day => {
                    const dayCourses = DEMO_SCHEDULE.filter(c => c.weekday === day);
                    if (dayCourses.length === 0) return null;
                    return (
                      <div key={day} className="py-1">
                        <span className="font-medium text-blue-600">{WEEKDAY_NAMES[day]}</span>
                        <span className="text-gray-400 ml-2">{dayCourses.length}节课</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Download Sample */}
            <div className="bg-gradient-to-br from-blue-50 to-purple-50 dark:from-blue-900/30 dark:to-purple-900/30 rounded-2xl border border-blue-200 dark:border-blue-800 p-4">
              <h3 className="font-semibold mb-2 text-gray-900 dark:text-white">📁 示例文件</h3>
              <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
                下载真实学生课表文件，测试导入功能
              </p>
              <div className="space-y-2">
                <a 
                  href="/api/demo/schedule.xlsx" 
                  className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
                >
                  <Download size={14} /> yanle-schedule.xlsx
                </a>
                <a 
                  href="/api/demo/schedule.ics" 
                  className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
                >
                  <Download size={14} /> yanle-schedule.ics
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Feature Comparison */}
        <div className="mt-12 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-xl font-bold mb-6 text-center text-gray-900 dark:text-white">核心差异化对比</h3>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800">
              <h4 className="font-semibold text-red-700 dark:text-red-400 mb-3">❌ 传统 AI 助手</h4>
              <ul className="text-sm space-y-2 text-red-600 dark:text-red-300">
                <li>• 没有数据也会编造答案</li>
                <li>• 所有场景用同一种语气</li>
                <li>• 只支持单一输入方式</li>
                <li>• 出错显示技术报错</li>
              </ul>
            </div>
            <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-xl border border-green-200 dark:border-green-800">
              <h4 className="font-semibold text-green-700 dark:text-green-400 mb-3">✅ Campus Copilot</h4>
              <ul className="text-sm space-y-2 text-green-600 dark:text-green-300">
                <li>• 无数据时坚决不编造</li>
                <li>• 查课专业，闲聊可爱</li>
                <li>• Excel/ICS/OCR/手动/链接</li>
                <li>• 产品化错误引导</li>
              </ul>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-700 mt-12 py-6">
        <div className="max-w-6xl mx-auto px-4 text-center text-sm text-gray-500">
          Built with ❤️ for Microsoft Imagine Cup 2026
        </div>
      </footer>
    </div>
  );
}
