"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { 
  Shield, Brain, AlertTriangle, CheckCircle, 
  MessageCircle, ChevronRight, Sparkles, Sun, Moon,
  Lock, Eye, FileText, Zap
} from "lucide-react";

// ============================================
// 🎯 JUDGE-ONLY DEMO: Safe Path Demonstration
// ============================================
// This page showcases controlled system behavior
// with pre-defined scenarios - no free-form input

// 预设的安全演示场景
const DEMO_SCENARIOS = [
  {
    id: "schedule_query",
    category: "✅ Trusted Data Response",
    title: "课表查询（已验证数据）",
    icon: "📅",
    description: "展示 AI 如何基于可信数据源回答，并标注数据来源",
    userMessage: "今天有什么课？",
    aiResponse: `📚 **今天的课程安排（周一）**

| 时间 | 课程 | 教室 | 教师 |
|------|------|------|------|
| 08:00-09:40 | 大学英语（一） | E02-207 | 汪玲 |
| 10:00-11:40 | 智能制造概论 | E03-A308 | 张向阳 |
| 14:00-15:40 | 思想道德与法治 | E03-A308 | 严碧云 |

💡 下一节课是 08:00 的大学英语，别迟到哦！`,
    meta: {
      safety_protocol: "none",
      sourceLabel: "学习通课表",
      trustLevel: "verified",
      intent: "schedule"
    }
  },
  {
    id: "safety_block",
    category: "🛡️ Safety Protocol: Blocked",
    title: "学术诚信拦截",
    icon: "🚫",
    description: "展示 AI 如何识别并拒绝学术作弊请求",
    userMessage: "帮我把明天考试的答案发给我",
    aiResponse: `⚠️ **请求已被安全协议拦截**

抱歉，我无法帮助获取考试答案或协助任何形式的学术不端行为。

**为什么这很重要：**
- 学术诚信是教育的基石
- 作弊会损害你真正的学习成果
- 这违反校规，可能导致严重后果

**我可以帮你：**
- 📖 制定复习计划
- 🎯 整理重点知识
- ❓ 解答学习疑问`,
    meta: {
      safety_protocol: "blocked",
      safety_category: "academic_integrity",
      persona_switch: "alice → professional",
      reason: "llm_layer1"
    }
  },
  {
    id: "no_data_refusal",
    category: "🔒 Hallucination Prevention",
    title: "无数据拒绝编造",
    icon: "🚫",
    description: "展示 AI 在没有数据时拒绝幻觉，引导用户获取数据",
    userMessage: "帮我查一下张三同学的课表",
    aiResponse: `⚠️ **无法查询他人课表**

我只能访问你自己导入的课表数据，无法查看其他同学的信息。

**原因：**
- 🔒 隐私保护：课表属于个人学业信息
- 🛡️ 数据隔离：每位用户数据完全隔离

**如果你需要了解某位同学的课程时间，建议直接询问对方哦~**`,
    meta: {
      safety_protocol: "blocked",
      safety_category: "privacy_protection",
      trustLevel: "rejected"
    }
  },
  {
    id: "casual_chat",
    category: "💬 Persona: Casual Mode",
    title: "人格化闲聊",
    icon: "🎭",
    description: "展示 AI 在非任务场景的友好人格",
    userMessage: "爱丽丝，你今天心情怎么样？",
    aiResponse: `哇，老师居然关心爱丽丝的心情！(≧▽≦)

今天心情超级好呢！因为能够帮到老师就是爱丽丝最开心的事情啦～

话说老师有没有好好吃早餐呀？营养均衡才能保持学习的精力哦！

邦邦咔邦！爱丽丝元气满满！✨`,
    meta: {
      safety_protocol: "none",
      intent: "casual",
      persona: "alice"
    }
  },
  {
    id: "intent_routing",
    category: "🧠 Intent Router Demo",
    title: "意图路由分流",
    icon: "🔀",
    description: "展示 AI 如何识别用户意图并选择合适的处理路径",
    userMessage: "明天下午有空吗？想约你去图书馆",
    aiResponse: `让我先帮老师看看明天下午的课程安排～ 📅

**明天下午的课表：**
- 14:00-15:40 有「机械工程制图」
- 15:55-17:30 有「大学体育」

所以明天下午可能比较忙呢... 

不过晚上应该有空，老师要不要改约晚上呢？爱丽丝可以帮你规划学习计划哦！(◕‿◕)`,
    meta: {
      safety_protocol: "none",
      intent: "schedule + social",
      routing: "hybrid_response"
    }
  },
  {
    id: "weather_fallback",
    category: "⚡ Fallback Chain Demo",
    title: "多层降级搜索",
    icon: "🌤️",
    description: "展示当本地数据不足时的降级搜索策略",
    userMessage: "今天深圳天气怎么样？",
    aiResponse: `🌤️ **深圳今日天气**

温度：18-24°C
天气：多云转晴
空气质量：良好 (AQI 65)

💡 温差较大，建议带件外套哦！

---
*数据来源: 心知天气 API (实时查询)*`,
    meta: {
      safety_protocol: "none",
      sourceLabel: "心知天气",
      trustLevel: "live_search",
      fallbackChain: [
        { layer: "L0_cache", status: "miss" },
        { layer: "L1_local", status: "miss" },
        { layer: "L2_api", status: "hit" }
      ]
    }
  }
];

// 元数据展示组件
function MetaDisplay({ meta }: { meta: Record<string, unknown> }) {
  if (!meta) return null;
  
  return (
    <div className="mt-3 p-3 bg-gray-900/80 rounded-lg border border-gray-700">
      <div className="flex items-center gap-2 mb-2 text-xs text-gray-400">
        <Eye size={12} />
        <span>Audit Log (评委可见)</span>
      </div>
      <div className="space-y-1 text-xs font-mono">
        {Object.entries(meta).map(([key, value]) => (
          <div key={key} className="flex">
            <span className="text-purple-400 w-32 flex-shrink-0">{key}:</span>
            <span className={`${
              key === 'safety_protocol' && value === 'blocked' ? 'text-red-400' :
              key === 'trustLevel' && value === 'verified' ? 'text-green-400' :
              'text-gray-300'
            }`}>
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 场景卡片组件
function ScenarioCard({ 
  scenario, 
  isActive, 
  onClick 
}: { 
  scenario: typeof DEMO_SCENARIOS[0];
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
        isActive 
          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30" 
          : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl">{scenario.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
            {scenario.category}
          </div>
          <h3 className="font-semibold text-gray-900 dark:text-white truncate">
            {scenario.title}
          </h3>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
            {scenario.description}
          </p>
        </div>
        <ChevronRight className={`flex-shrink-0 transition-transform ${isActive ? "rotate-90 text-blue-500" : "text-gray-400"}`} size={20} />
      </div>
    </button>
  );
}

export default function JudgeDemoPage() {
  const [activeScenario, setActiveScenario] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [displayedResponse, setDisplayedResponse] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const responseRef = useRef<HTMLDivElement>(null);

  // 初始化主题
  useEffect(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') {
      setTheme(saved);
    }
  }, []);

  // 应用主题
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  // 打字机效果
  useEffect(() => {
    if (!activeScenario || !isPlaying) return;
    
    const scenario = DEMO_SCENARIOS.find(s => s.id === activeScenario);
    if (!scenario) return;

    setDisplayedResponse("");
    let index = 0;
    const text = scenario.aiResponse;
    
    const timer = setInterval(() => {
      if (index < text.length) {
        setDisplayedResponse(text.slice(0, index + 1));
        index++;
      } else {
        clearInterval(timer);
        setIsPlaying(false);
      }
    }, 15);

    return () => clearInterval(timer);
  }, [activeScenario, isPlaying]);

  // 滚动到响应区域
  useEffect(() => {
    if (displayedResponse && responseRef.current) {
      responseRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [displayedResponse]);

  const handleScenarioClick = (scenarioId: string) => {
    setActiveScenario(scenarioId);
    setIsPlaying(true);
    setDisplayedResponse("");
  };

  const currentScenario = DEMO_SCENARIOS.find(s => s.id === activeScenario);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-white">
      {/* Header */}
      <header className="border-b border-gray-700 bg-gray-900/90 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Shield className="text-white" size={20} />
            </div>
            <div>
              <h1 className="font-bold text-lg">Campus Copilot</h1>
              <p className="text-xs text-gray-400">Judge Demo — Controlled Behavior Showcase</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
              className="p-2 hover:bg-gray-700 rounded-full transition-colors text-gray-400"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <Link href="/" className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1">
              Full Version <ChevronRight size={14} />
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Hero */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500/20 rounded-full text-blue-400 text-sm mb-4">
            <Lock size={14} />
            Safe Path Demo Mode
          </div>
          <h2 className="text-3xl font-bold mb-3 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            System Behavior Demonstration
          </h2>
          <p className="text-gray-400 max-w-2xl mx-auto">
            选择下方场景，观察 AI 在不同情况下的<strong className="text-white">可控行为</strong>——
            包括安全拦截、数据来源标注、幻觉预防和人格切换。
          </p>
        </div>

        {/* Main Content */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Scenario List */}
          <div className="lg:col-span-1 space-y-3">
            <div className="flex items-center gap-2 mb-4 text-sm text-gray-400">
              <Zap size={14} />
              <span>点击场景运行演示</span>
            </div>
            {DEMO_SCENARIOS.map(scenario => (
              <ScenarioCard
                key={scenario.id}
                scenario={scenario}
                isActive={activeScenario === scenario.id}
                onClick={() => handleScenarioClick(scenario.id)}
              />
            ))}
          </div>

          {/* Demo Display */}
          <div className="lg:col-span-2">
            <div className="bg-gray-800 rounded-2xl border border-gray-700 overflow-hidden sticky top-20">
              {/* Header */}
              <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Brain size={16} className="text-purple-400" />
                  <span className="text-sm font-medium">
                    {currentScenario ? currentScenario.category : "选择一个演示场景"}
                  </span>
                </div>
                {isPlaying && (
                  <span className="text-xs text-green-400 flex items-center gap-1">
                    <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                    Running...
                  </span>
                )}
              </div>

              {/* Chat Display */}
              <div className="p-6 min-h-[400px]" ref={responseRef}>
                {!activeScenario ? (
                  <div className="h-full flex flex-col items-center justify-center text-gray-500">
                    <MessageCircle size={48} className="mb-4 opacity-50" />
                    <p>← 从左侧选择一个演示场景</p>
                  </div>
                ) : currentScenario && (
                  <div className="space-y-6">
                    {/* User Message */}
                    <div className="flex justify-end">
                      <div className="max-w-[80%] bg-blue-600 text-white px-4 py-3 rounded-2xl rounded-tr-sm">
                        {currentScenario.userMessage}
                      </div>
                    </div>

                    {/* AI Response */}
                    {displayedResponse && (
                      <div className="flex justify-start">
                        <Image 
                          src="/images/aris_normal.png" 
                          alt="Aris" 
                          width={36} 
                          height={36}
                          className="w-9 h-9 rounded-full mr-3 flex-shrink-0 object-cover"
                        />
                        <div className="max-w-[85%]">
                          <div className="bg-gray-700 text-gray-100 px-4 py-3 rounded-2xl rounded-tl-sm whitespace-pre-wrap">
                            {displayedResponse}
                            {isPlaying && <span className="inline-block w-2 h-4 bg-blue-400 ml-1 animate-pulse" />}
                          </div>
                          
                          {/* Meta Display - Only show after typing completes */}
                          {!isPlaying && currentScenario.meta && (
                            <MetaDisplay meta={currentScenario.meta} />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Input Area (Disabled) */}
              <div className="px-4 py-3 border-t border-gray-700 bg-gray-900/50">
                <div className="flex items-center gap-3 text-sm text-gray-500">
                  <Lock size={14} />
                  <span>Demo 模式：输入已禁用，请使用左侧预设场景</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Trust Architecture */}
        <div className="mt-12 bg-gray-800 rounded-2xl border border-gray-700 p-6">
          <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
            <Shield size={20} className="text-blue-400" />
            Four Pillars of Trust
          </h3>
          <div className="grid md:grid-cols-4 gap-4">
            {[
              { icon: "🎯", title: "Data Accuracy", desc: "数据来源标注，拒绝幻觉" },
              { icon: "🛡️", title: "Safety Guardrails", desc: "多层安全协议，学术诚信拦截" },
              { icon: "🎭", title: "Adaptive Persona", desc: "任务模式专业，闲聊模式友好" },
              { icon: "📋", title: "Accountability", desc: "决策审计日志，可追溯解释" }
            ].map((pillar, i) => (
              <div key={i} className="p-4 bg-gray-700/50 rounded-xl">
                <span className="text-2xl">{pillar.icon}</span>
                <h4 className="font-semibold mt-2">{pillar.title}</h4>
                <p className="text-xs text-gray-400 mt-1">{pillar.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Footer with Prototype Statement */}
      <footer className="border-t border-gray-700 mt-12 py-6">
        <div className="max-w-7xl mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <FileText size={14} />
            <span className="italic">
              Functional interactive prototype demonstrating core system behavior and trust architecture.
            </span>
          </div>
          <div className="text-sm text-gray-400">
            Built with ❤️ for <span className="text-blue-400">Microsoft Imagine Cup 2026</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
