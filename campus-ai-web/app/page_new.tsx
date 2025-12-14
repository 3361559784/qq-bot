"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Calendar, MessageCircle, BookOpen, Search, Settings, Send, ChevronDown, Plus, Image as ImageIcon, FileText, Table, Menu, PanelRightClose, Sun, Moon, Upload, Zap } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion, AnimatePresence } from "framer-motion";
import AliceAvatar, { type AliceEmotion } from "../components/AliceAvatar";
import ThinkingAnimation from "../components/ThinkingAnimation";
import { sendMessage, sendPoke } from "../services/chat";
import Sidebar from "../components/Sidebar";
import RightPanel from "../components/RightPanel";
import ScheduleImport from "../components/ScheduleImport";
import PlanCard, { parsePlanText, type DayPlan } from "../components/PlanCard";
import DemoPreset, { DEMO_SCHEDULE } from "../components/DemoPreset";

const MODES = [
  { name: "Plan", icon: Calendar, label: "智能计划" },
  { name: "Search", icon: Search, label: "联网搜索" },
  { name: "Ask", icon: MessageCircle, label: "日常闲聊" },
  { name: "Class", icon: BookOpen, label: "课程查询" },
];

// 模拟后端回复
const MOCK_REPLIES = [
  "我是爱丽丝，我现在只负责卖萌，后端还没接好哦 (✨ω✨)",
  "老师，爱丽丝正在努力学习中，请稍后再试！(◕‿◕)",
  "收到！但是爱丽丝现在还不能处理这个请求呢... (´• ω •`)",
  "邦邦咔邦！爱丽丝登场！(≧∇≦)/"
];

function ChatMessage({ role, content }: { role: string, content: string }) {
  const isUser = role === "user";
  return (
    <div className={`flex w-full mb-8 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <img
          src="/images/aris_normal.png"
          alt="Aris"
          className="w-8 h-8 rounded-full object-cover mr-4 flex-shrink-0 shadow-sm"
          loading="lazy"
        />
      )}
      <div className={`max-w-[85%] break-words ${
        isUser 
          ? "bg-blue-100 dark:bg-blue-900/30 text-gray-800 dark:text-gray-100 px-5 py-3 rounded-2xl rounded-tr-sm" 
          : "text-gray-800 dark:text-gray-100 leading-7 pt-1"
      }`}>
        {isUser ? content : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              table: ({ children }) => (
                <table className="min-w-full border-collapse my-2 text-sm">
                  {children}
                </table>
              ),
              thead: ({ children }) => (
                <thead className="bg-blue-600 text-white">{children}</thead>
              ),
              th: ({ children }) => (
                <th className="px-3 py-2 text-left font-medium border border-gray-600">{children}</th>
              ),
              td: ({ children }) => (
                <td className="px-3 py-2 border border-gray-600">{children}</td>
              ),
              tr: ({ children }) => (
                <tr className="even:bg-gray-800/30 odd:bg-gray-700/30">{children}</tr>
              ),
              p: ({ children }) => <p className="mb-2">{children}</p>,
              strong: ({ children }) => <strong className="font-bold text-blue-400">{children}</strong>,
            }}
          >
            {content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}

function ChatInput({
  variant,
  input,
  setInput,
  setCurrentMode,
  currentMode,
  isModeMenuOpen,
  setIsModeMenuOpen,
  isAttachmentMenuOpen,
  setIsAttachmentMenuOpen,
  toggleModeMenu,
  toggleAttachmentMenu,
  handleSend,
  handleKeyDown,
  inputAreaRef,
  onOpenScheduleImport,
}: {
  variant: "center" | "bottom";
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  setCurrentMode: React.Dispatch<React.SetStateAction<string>>;
  currentMode: string;
  isModeMenuOpen: boolean;
  setIsModeMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isAttachmentMenuOpen: boolean;
  setIsAttachmentMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggleModeMenu: () => void;
  toggleAttachmentMenu: () => void;
  handleSend: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  inputAreaRef: React.RefObject<HTMLDivElement | null>;
  onOpenScheduleImport?: () => void;
}) {
  const isCenter = variant === "center";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const CurrentModeIcon = MODES.find((m) => m.name === currentMode)?.icon || MessageCircle;
  const currentModeLabel = MODES.find((m) => m.name === currentMode)?.label || "日常闲聊";

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [input]);

  return (
    <div className={isCenter ? "w-full" : "w-full bg-white dark:bg-gray-950 pb-6 pt-2 px-4"}>
      <div className={isCenter ? "w-full" : "max-w-3xl mx-auto"}>
        <div
          className={`relative rounded-[2rem] transition-all duration-200 border backdrop-blur-xl shadow-lg ${
            input.trim() ? "rounded-[1.5rem]" : ""
          } bg-white/70 dark:bg-gray-900/50 border-gray-200/70 dark:border-gray-700/60`}
        >
          <div className="flex items-end px-4 py-3 min-h-[56px]" ref={inputAreaRef}>
            <textarea
              ref={textareaRef}
              className="flex-1 bg-transparent border-none focus:ring-0 p-0 text-base leading-6 resize-none max-h-32 text-gray-800 dark:text-gray-100 placeholder-gray-500 py-1 scrollbar-hide focus:outline-none"
              placeholder={`问问 ${currentModeLabel} 的爱丽丝...`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              style={{ height: 'auto', minHeight: '24px' }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
              }}
            />

            <div className="flex items-center gap-2 ml-2 pb-0.5">
              {!input.trim() && (
                <>
                  <div className="relative">
                    <button
                      className="flex items-center gap-1 px-3 py-2 bg-white/60 dark:bg-gray-800/70 border border-gray-200/60 dark:border-gray-700/60 rounded-full text-gray-700 dark:text-gray-200 hover:bg-white/80 dark:hover:bg-gray-700/70 transition-colors"
                      onClick={toggleModeMenu}
                    >
                      <CurrentModeIcon size={16} />
                      <span className="text-sm font-medium">{currentMode}</span>
                      <ChevronDown
                        size={14}
                        className={`transition-transform duration-200 ${isModeMenuOpen ? 'rotate-180' : ''}`}
                      />
                    </button>

                    {isModeMenuOpen && (
                      <div className="absolute bottom-full right-0 mb-3 w-56 bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl rounded-2xl shadow-xl border border-gray-100/70 dark:border-gray-700/70 overflow-hidden py-2 animate-in fade-in slide-in-from-bottom-4 z-50">
                        <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">切换模式</div>
                        {MODES.map((mode) => (
                          <button
                            key={mode.name}
                            className={`w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-gray-50/70 dark:hover:bg-gray-700/60 transition-colors ${
                              currentMode === mode.name
                                ? 'bg-blue-50/70 dark:bg-blue-900/20 text-blue-600'
                                : 'text-gray-700 dark:text-gray-200'
                            }`}
                            onClick={() => {
                              setCurrentMode(mode.name);
                              setIsModeMenuOpen(false);
                              setIsAttachmentMenuOpen(false);
                            }}
                          >
                            <div
                              className={`p-1.5 rounded-lg ${
                                currentMode === mode.name
                                  ? 'bg-blue-100/70 dark:bg-blue-800/60'
                                  : 'bg-gray-100/70 dark:bg-gray-700/60'
                              }`}
                            >
                              <mode.icon size={16} />
                            </div>
                            <div className="flex flex-col items-start">
                              <span className="font-medium">{mode.name}</span>
                              <span className="text-xs text-gray-500 dark:text-gray-400">{mode.label}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="relative">
                    <button
                      className="p-2 bg-white/60 dark:bg-gray-800/70 border border-gray-200/60 dark:border-gray-700/60 rounded-full text-gray-600 dark:text-gray-300 hover:bg-white/80 dark:hover:bg-gray-700/70 transition-colors"
                      onClick={toggleAttachmentMenu}
                    >
                      <Plus size={20} className={`transition-transform duration-300 ${isAttachmentMenuOpen ? 'rotate-45' : ''}`} />
                    </button>

                    {isAttachmentMenuOpen && (
                      <div className="absolute bottom-full right-0 mb-3 w-48 bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl rounded-2xl shadow-xl border border-gray-100/70 dark:border-gray-700/70 overflow-hidden py-2 animate-in fade-in slide-in-from-bottom-4 z-50">
                        <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">上传</div>
                        <button 
                          onClick={() => {
                            onOpenScheduleImport?.();
                            setIsAttachmentMenuOpen(false);
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50/70 dark:hover:bg-gray-700/60 transition-colors"
                        >
                          <Calendar size={16} />
                          <span>导入课表</span>
                        </button>
                        <button className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50/70 dark:hover:bg-gray-700/60 transition-colors">
                          <ImageIcon size={16} />
                          <span>图片</span>
                        </button>
                        <button className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50/70 dark:hover:bg-gray-700/60 transition-colors">
                          <FileText size={16} />
                          <span>文件</span>
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}

              {input.trim() && (
                <button
                  data-send-btn
                  className="p-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-all shadow-md"
                  onClick={handleSend}
                >
                  <Send size={18} />
                </button>
              )}
            </div>
          </div>
        </div>

        {!isCenter && (
          <div className="text-center mt-3">
            <p className="text-[11px] text-gray-400">
              Tendon Arisu may display inaccurate info, including about people, so double-check its responses.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const [currentMode, setCurrentMode] = useState("Ask");
  const [messages, setMessages] = useState<Array<{role: string, content: string}>>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isAvatarExpanded, setIsAvatarExpanded] = useState(true);
  const [ringAnim, setRingAnim] = useState<"none" | "fill" | "empty">("none");
  const [ringDashOffset, setRingDashOffset] = useState(157);
  const avatarWrapRef = useRef<HTMLDivElement | null>(null);
  const toggleBtnRef = useRef<HTMLButtonElement | null>(null);
  const trailTimeoutRef = useRef<number | null>(null);
  const [trail, setTrail] = useState<{ d: string; mode: "none" | "toButton" | "toAvatar"; key: number }>({
    d: "",
    mode: "none",
    key: 0,
  });
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [showScheduleImport, setShowScheduleImport] = useState(false);
  const [schedule, setSchedule] = useState<any[]>([]);
  const [conversations, setConversations] = useState([
    { id: "1", title: "复习计划" },
    { id: "2", title: "明天天气" },
    { id: "3", title: "高数课在哪" },
  ]);
  
  // 好感度系统
  const [affection, setAffection] = useState(50); // 初始好感度 50
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const inputAreaRef = useRef<HTMLDivElement | null>(null);

  // 初始化时加载课表
  useEffect(() => {
    try {
      const saved = localStorage.getItem("campus_schedule");
      if (saved) {
        const parsed = JSON.parse(saved);
        setSchedule(parsed);
        console.log("📚 已加载课表:", parsed.length, "门课程");
      }
    } catch (e) {
      console.error("加载课表失败:", e);
    }
  }, []);

  const getSessionId = () => {
    if (!sessionIdRef.current) {
      sessionIdRef.current = `sid_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    }
    return sessionIdRef.current;
  };
  
  // 好感度等级计算
  const getAffectionLevel = useCallback((value: number) => {
    if (value >= 80) return { level: "亲密", color: "text-pink-500", icon: "💕" };
    if (value >= 60) return { level: "友好", color: "text-blue-500", icon: "💙" };
    if (value >= 40) return { level: "普通", color: "text-gray-500", icon: "🤍" };
    if (value >= 20) return { level: "疏远", color: "text-yellow-500", icon: "💛" };
    return { level: "厌恶", color: "text-red-500", icon: "💔" };
  }, []);
  
  // 好感度变化处理
  const handleAffectionChange = useCallback((delta: number) => {
    setAffection(prev => Math.max(0, Math.min(100, prev + delta)));
  }, []);

  // 自动滚动
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 点击框外关闭下拉菜单
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (inputAreaRef.current && !inputAreaRef.current.contains(target)) {
        setIsModeMenuOpen(false);
        setIsAttachmentMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // 明暗主题：默认跟随系统；用户切换后写入 localStorage
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('theme') : null;
    if (saved === 'light' || saved === 'dark') {
      setTheme(saved);
      return;
    }
    const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
    setTheme(prefersDark ? 'dark' : 'light');
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      window.localStorage.setItem('theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMessage }]);
    setIsLoading(true);

    window.dispatchEvent(new CustomEvent("alice:emotion", {
      detail: { emotion: "thinking", showBubble: true }
    }));

    try {
      let reply = "";
      let emotion = null;

      // 🔄 统一调用后端 LLM（双模型架构）
      // 后端会通过 Perception 模型理解上下文和用户意图
      // 然后由 Response 模型生成智能回复
      // 前端不再做本地硬编码回复，确保对话连贯性
      
      // 构建增强的消息（包含模式提示）
      let enhancedMessage = userMessage;
      if (currentMode === "Class" && schedule.length > 0) {
        enhancedMessage = `[课程查询模式] ${userMessage}`;
      } else if (currentMode === "Plan" && schedule.length > 0) {
        enhancedMessage = `[学习规划模式] ${userMessage}`;
      } else if (currentMode === "Search") {
        enhancedMessage = `搜索:${userMessage}`;
      }
      
      // 统一调用后端 chat API
      const result = await sendMessage(
        enhancedMessage,
        getSessionId(),
        { mode: currentMode, schedule: schedule.length > 0 ? schedule : undefined }
      );
      reply = result.reply;
      emotion = result.emotion;
      
      console.log(`📬 [${currentMode}模式] 后端回复:`, reply?.substring(0, 100));

      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
      
      // 使用后端返回的情绪，如果没有则根据内容推断
      const finalEmotion = emotion || inferEmotionFromContent(reply);
      window.dispatchEvent(new CustomEvent("alice:emotion", {
        detail: { emotion: finalEmotion, showBubble: true }
      }));
    } catch (error) {
      console.error('Failed to send message:', error);
      setMessages(prev => [...prev, { role: "assistant", content: "抱歉，爱丽丝遇到了一些问题 (╥﹏╥)" }]);
      
      window.dispatchEvent(new CustomEvent("alice:emotion", {
        detail: { emotion: "sad", showBubble: true }
      }));
    } finally {
      setIsLoading(false);
    }
  };

  // 从回复内容推断情绪
  const inferEmotionFromContent = (content: string): AliceEmotion => {
    const lower = content.toLowerCase();
    if (/[😊🎉✨💕]|开心|高兴|太棒|邦邦咔邦/.test(lower)) return "joyful";
    if (/[😢😭💔]|抱歉|对不起|难过|伤心/.test(lower)) return "sad";
    if (/[😳🙈💦]|害羞|不好意思/.test(lower)) return "shy";
    if (/[😠💢]|生气|讨厌/.test(lower)) return "angry";
    if (/[😰😨]|紧张|担心|焦虑/.test(lower)) return "anxious";
    if (/[🤔💭]|让我想想|思考/.test(lower)) return "thinking";
    if (/[😊😄]|好的|没问题|当然/.test(lower)) return "happy";
    return "normal";
  };

  // 戳一戳处理 - 与后端联动（现在由 AliceAvatar 组件内部处理）
  const handlePoke = useCallback(async (pokeCount: number, mood: string) => {
    // 如果是生气状态，扣好感度已经在组件内处理
    // 这里只负责与后端联动获取回复
    try {
      // 传递当前心情状态，让回复与表情同步
      const { reply, emotion } = await sendPoke(getSessionId(), { mood });
      if (reply) {
        setMessages(prev => [...prev, { role: "assistant", content: reply }]);
        
        // 同步表情到 Alice 头像
        if (emotion) {
          window.dispatchEvent(new CustomEvent("alice:emotion", {
            detail: { emotion, showBubble: false }
          }));
        }
        
        // 根据心情增减好感度
        if (mood === "happy") {
          handleAffectionChange(1); // 开心时增加好感
        }
      }
    } catch (error) {
      console.error('Poke failed:', error);
    }
  }, [handleAffectionChange]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 兼容中文输入法：回车用于上屏时不触发发送
    if ((e.nativeEvent as any)?.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleAttachmentMenu = () => {
    setIsAttachmentMenuOpen((prev) => {
      const next = !prev;
      if (next) setIsModeMenuOpen(false);
      return next;
    });
  };

  const toggleModeMenu = () => {
    setIsModeMenuOpen((prev) => {
      const next = !prev;
      if (next) setIsAttachmentMenuOpen(false);
      return next;
    });
  };

  const handleNewChat = () => {
    setMessages([]);
    setInput("");
  };

  const handleSelectChat = (id: string) => {
    console.log("Selected chat:", id);
  };

  const toggleAvatar = () => {
    // 先算一次轨迹（基于当前布局），再触发状态切换
    const avatarRect = avatarWrapRef.current?.getBoundingClientRect() || null;
    const btnRect = toggleBtnRef.current?.getBoundingClientRect() || null;
    if (avatarRect && btnRect) {
      const center = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      const from = isAvatarExpanded ? center(avatarRect) : center(btnRect);
      const to = isAvatarExpanded ? center(btnRect) : center(avatarRect);
      const cx = (from.x + to.x) / 2;
      const cy = Math.min(from.y, to.y) - 160;
      const d = `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;

      setTrail((prev) => ({
        d,
        mode: isAvatarExpanded ? "toButton" : "toAvatar",
        key: prev.key + 1,
      }));

      if (trailTimeoutRef.current) window.clearTimeout(trailTimeoutRef.current);
      trailTimeoutRef.current = window.setTimeout(() => {
        setTrail((prev) => ({ ...prev, mode: "none" }));
      }, 520);
    }

    setIsAvatarExpanded((prev) => {
      const next = !prev;

      if (next) {
        // 展开：先让圆环从“满”回收为空
        setRingDashOffset(0);
        setRingAnim("empty");
      } else {
        // 坍缩：先让圆环从“空”描边到“满”
        setRingDashOffset(157);
        setRingAnim("fill");
      }

      return next;
    });
  };

  return (
    <div className="flex h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans overflow-hidden">

      {/* 头像→按钮 过渡轨迹线层 */}
      {trail.mode !== "none" && trail.d && (
        <svg
          key={trail.key}
          className="fixed inset-0 z-40 pointer-events-none"
          width="100%"
          height="100%"
          viewBox={`0 0 ${typeof window !== "undefined" ? window.innerWidth : 1000} ${typeof window !== "undefined" ? window.innerHeight : 1000}`}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id="trail-blue-white-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#60A5FA" />
              <stop offset="0.5" stopColor="#BFDBFE" />
              <stop offset="1" stopColor="#FFFFFF" />
            </linearGradient>
          </defs>
          <path
            d={trail.d}
            pathLength={1}
            stroke="url(#trail-blue-white-gradient)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={1}
            strokeDashoffset={trail.mode === "toButton" ? 1 : 0}
            className={trail.mode === "toButton" ? "animate-trail-draw" : "animate-trail-erase"}
          />
        </svg>
      )}
      
      {/* 左侧边栏 */}
      <Sidebar
        isOpen={isLeftSidebarOpen}
        onToggle={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
        conversations={conversations}
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
      />

      {/* 主聊天区域 */}
      <div
        className={`flex-1 flex flex-col h-full relative z-10 transition-all duration-300 ${
          isLeftSidebarOpen ? "lg:ml-64" : "lg:ml-0"
        } ${
          isRightPanelOpen ? "lg:mr-80" : "lg:mr-0"
        }`}
      >
        
        {/* 顶部导航 (极简) */}
        <div className="h-16 flex items-center justify-between px-6 sticky top-0 bg-white/80 dark:bg-gray-950/80 backdrop-blur-md z-20">
           <div className="flex items-center gap-3">
              {/* 左侧边栏切换按钮 - 始终显示三横线图标 */}
              <button 
                onClick={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
                title={isLeftSidebarOpen ? "隐藏侧边栏" : "显示侧边栏"}
              >
                <Menu size={22} />
              </button>
              
              <div className="flex items-center gap-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 cursor-pointer transition-colors">
                <span className="font-medium text-lg">Tendon Arisu</span>
                <ChevronDown size={16} />
              </div>
           </div>
           <div className="flex items-center gap-4">
              {/* 右侧面板切换按钮 */}
              <button 
                onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                title={isRightPanelOpen ? "隐藏上下文" : "显示上下文"}
              >
                <PanelRightClose size={20} className={isRightPanelOpen ? "" : "rotate-180"} />
              </button>

              {/* 明暗主题切换 */}
              <button
                onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
              >
                {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
              </button>
              
              <button className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors text-gray-500">
                <Settings size={20} />
              </button>
              <div className="w-8 h-8 bg-purple-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
                S
              </div>
           </div>
        </div>

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-4 scroll-smooth">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-start justify-center max-w-3xl mx-auto pb-32">
              {/* Demo 预设按钮（评委作弊码） */}
              <DemoPreset
                hasSchedule={schedule.length > 0}
                onLoadSchedule={(demoSchedule) => {
                  setSchedule(demoSchedule);
                  localStorage.setItem("campus_schedule", JSON.stringify(demoSchedule));
                  setMessages(prev => [...prev, { 
                    role: "assistant", 
                    content: `📚 示例课表已导入！共 ${demoSchedule.length} 门课程，现在可以开始演示了～` 
                  }]);
                }}
                onSendQuestion={(mode, question) => {
                  setCurrentMode(mode);
                  setInput(question);
                  // 延迟触发发送
                  setTimeout(() => {
                    const sendBtn = document.querySelector('[data-send-btn]') as HTMLButtonElement;
                    sendBtn?.click();
                  }, 100);
                }}
              />

              {/* 产品定位说明 */}
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 flex items-center gap-2">
                🎓 大学生专属 AI 助手 · 一键导入课表 · 智能规划学习
              </p>
              <h1 className="text-5xl font-medium bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 bg-clip-text text-transparent mb-2">
                你好，同学
              </h1>
              <h2 className="text-4xl font-medium text-gray-700 dark:text-gray-300 mb-6">
                {schedule.length > 0 ? '今天想做点什么？' : '导入课表，让 AI 帮你规划'}
              </h2>
              
              {/* 空状态时显示明显的导入按钮 */}
              {schedule.length === 0 && (
                <div className="mb-8 flex flex-col items-center gap-4">
                  <button
                    onClick={() => setShowScheduleImport(true)}
                    className="px-8 py-4 bg-blue-500 hover:bg-blue-600 text-white rounded-full font-medium text-lg transition-all shadow-lg hover:shadow-xl flex items-center gap-3"
                  >
                    <Calendar size={24} />
                    导入我的课表
                  </button>
                  <span className="text-gray-400 text-sm">或</span>
                  <button
                    onClick={() => {
                      // 使用 Demo 课表
                      setSchedule(DEMO_SCHEDULE);
                      setMessages([{ role: 'assistant', content: '📚 已加载示例课表！你可以试试问我「下一节课是什么」或「帮我安排学习计划」～' }]);
                    }}
                    className="px-6 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full text-sm transition-colors text-gray-600 dark:text-gray-300"
                  >
                    🎮 使用示例课表快速体验
                  </button>
                </div>
              )}
              
              {/* 已有课表时显示快捷操作 */}
              {schedule.length > 0 && (
                <div className="mb-8 flex flex-wrap gap-3">
                  <button
                    onClick={() => { setCurrentMode('Class'); setInput('下一节课是什么'); }}
                    className="px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-sm transition-colors"
                  >
                    📚 下一节课是什么
                  </button>
                  <button
                    onClick={() => { setCurrentMode('Class'); setInput('今天有什么课'); }}
                    className="px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-sm transition-colors"
                  >
                    📅 今天的课程
                  </button>
                  <button
                    onClick={() => { setCurrentMode('Plan'); setInput('帮我安排今天的学习计划'); }}
                    className="px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-sm transition-colors"
                  >
                    ✨ 生成学习计划
                  </button>
                </div>
              )}

              <div className="w-full mt-2">
                <ChatInput
                  variant="center"
                  input={input}
                  setInput={setInput}
                  setCurrentMode={setCurrentMode}
                  currentMode={currentMode}
                  isModeMenuOpen={isModeMenuOpen}
                  setIsModeMenuOpen={setIsModeMenuOpen}
                  isAttachmentMenuOpen={isAttachmentMenuOpen}
                  setIsAttachmentMenuOpen={setIsAttachmentMenuOpen}
                  toggleModeMenu={toggleModeMenu}
                  toggleAttachmentMenu={toggleAttachmentMenu}
                  handleSend={handleSend}
                  handleKeyDown={handleKeyDown}
                  inputAreaRef={inputAreaRef}
                  onOpenScheduleImport={() => setShowScheduleImport(true)}
                />
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto w-full py-8">
              {messages.map((msg, idx) => (
                <ChatMessage key={idx} role={msg.role} content={msg.content} />
              ))}
              {isLoading && (
                <div className="flex w-full mb-8 justify-start items-start">
                   {/* 仅保留：ChatGPT 风格呼吸小圆点 */}
                   <div className="mr-4 flex-shrink-0 pt-1">
                     <ThinkingAnimation size="sm" />
                   </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {messages.length > 0 && (
          <ChatInput
            variant="bottom"
            input={input}
            setInput={setInput}
            setCurrentMode={setCurrentMode}
            currentMode={currentMode}
            isModeMenuOpen={isModeMenuOpen}
            setIsModeMenuOpen={setIsModeMenuOpen}
            isAttachmentMenuOpen={isAttachmentMenuOpen}
            setIsAttachmentMenuOpen={setIsAttachmentMenuOpen}
            toggleModeMenu={toggleModeMenu}
            toggleAttachmentMenu={toggleAttachmentMenu}
            handleSend={handleSend}
            handleKeyDown={handleKeyDown}
            inputAreaRef={inputAreaRef}
            onOpenScheduleImport={() => setShowScheduleImport(true)}
          />
        )}
      </div>

      {/* 右侧面板 */}
      <RightPanel
        isOpen={isRightPanelOpen}
        onToggle={() => setIsRightPanelOpen(!isRightPanelOpen)}
        currentMode={currentMode}
      />

      {/* 爱丽丝 Avatar (固定在右下角) */}
      <div className="fixed right-8 bottom-28 z-50 pointer-events-none">
        <div className="flex flex-col items-end gap-3 pointer-events-auto">
          {/* 3D 容器：使用 Framer Motion 实现流畅的弹簧动画 */}
          <AnimatePresence mode="wait">
            {isAvatarExpanded && (
              <motion.div
                ref={avatarWrapRef}
                className="w-56 h-56 origin-bottom-right"
                initial={{ 
                  opacity: 0, 
                  scale: 0.3, 
                  y: 60,
                  filter: "blur(8px)"
                }}
                animate={{ 
                  opacity: 1, 
                  scale: 1, 
                  y: 0,
                  filter: "blur(0px)"
                }}
                exit={{ 
                  opacity: 0, 
                  scale: 0.3, 
                  y: 60,
                  filter: "blur(8px)"
                }}
                transition={{
                  type: "spring",
                  stiffness: 300,
                  damping: 25,
                  mass: 0.8
                }}
              >
                <div className="w-full h-full flex items-center justify-center">
                  <AliceAvatar 
                    onPoke={handlePoke} 
                    onAffectionChange={handleAffectionChange}
                    affection={affection}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 量子坍缩按钮 */}
          <motion.button
            ref={toggleBtnRef}
            type="button"
            onClick={toggleAvatar}
            aria-label={isAvatarExpanded ? "坍缩爱丽丝" : "展开爱丽丝"}
            className="relative w-14 h-14 rounded-full bg-white/70 dark:bg-gray-900/60 border border-gray-200/70 dark:border-gray-700/60 backdrop-blur-xl shadow-lg hover:bg-white/85 dark:hover:bg-gray-800/70 transition-colors"
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            transition={{ type: "spring", stiffness: 400, damping: 17 }}
          >
            <svg
              className="absolute inset-0"
              width="56"
              height="56"
              viewBox="0 0 56 56"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <defs>
                <linearGradient id="blue-white-gradient" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#60A5FA" />
                  <stop offset="0.5" stopColor="#BFDBFE" />
                  <stop offset="1" stopColor="#FFFFFF" />
                </linearGradient>
              </defs>
              <circle
                cx="28"
                cy="28"
                r="25"
                stroke="url(#blue-white-gradient)"
                strokeWidth="4"
                strokeLinecap="round"
                fill="transparent"
                strokeDasharray="157"
                strokeDashoffset={ringDashOffset}
                className={
                  ringAnim === "fill"
                    ? "animate-ring-fill"
                    : ringAnim === "empty"
                      ? "animate-ring-empty"
                      : ""
                }
                style={{
                  opacity: !isAvatarExpanded || ringAnim !== "none" ? 1 : 0,
                }}
                onAnimationEnd={() => {
                  if (ringAnim === "fill") {
                    setRingDashOffset(0);
                    setRingAnim("none");
                  }
                  if (ringAnim === "empty") {
                    setRingDashOffset(157);
                    setRingAnim("none");
                  }
                }}
              />
            </svg>

            <motion.div
              className="absolute inset-0 flex items-center justify-center"
              animate={{ rotate: isAvatarExpanded ? 0 : 180 }}
              transition={{ type: "spring", stiffness: 200, damping: 20 }}
            >
              <ChevronDown size={18} className="text-gray-700 dark:text-gray-200" />
            </motion.div>
          </motion.button>
        </div>
      </div>

      {/* 课表导入模态框 */}
      {showScheduleImport && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <ScheduleImport
            onScheduleImported={(newSchedule) => {
              setSchedule(newSchedule);
              setShowScheduleImport(false);
              // 添加系统消息
              setMessages(prev => [...prev, { 
                role: "assistant", 
                content: `📚 课表导入成功！已解析 ${newSchedule.length} 门课程。现在可以问我"下一节课是什么"或者"帮我安排学习计划"啦！✨` 
              }]);
            }}
            onClose={() => setShowScheduleImport(false)}
          />
        </div>
      )}

    </div>
  );
}
