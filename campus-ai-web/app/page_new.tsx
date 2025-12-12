"use client";

import React, { useState, useEffect, useRef } from "react";
import { Calendar, MessageCircle, BookOpen, Search, Settings, Send, ChevronDown, Plus, Image as ImageIcon, FileText, Table, Menu, PanelRightClose, Sun, Moon } from "lucide-react";
import AliceAvatar from "../components/AliceAvatar";
import { sendMessage } from "../services/chat";
import Sidebar from "../components/Sidebar";
import RightPanel from "../components/RightPanel";

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
        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-400 to-blue-600 flex items-center justify-center mr-4 flex-shrink-0 shadow-sm text-white font-bold text-xs">
           Aris
        </div>
      )}
      <div className={`max-w-[85%] ${
        isUser 
          ? "bg-blue-100 dark:bg-blue-900/30 text-gray-800 dark:text-gray-100 px-5 py-3 rounded-2xl rounded-tr-sm" 
          : "text-gray-800 dark:text-gray-100 leading-7 pt-1"
      }`}>
        {content}
      </div>
    </div>
  );
}

export default function Home() {
  const [currentMode, setCurrentMode] = useState("Ask");
  const [messages, setMessages] = useState<Array<{role: string, content: string}>>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [conversations, setConversations] = useState([
    { id: "1", title: "复习计划" },
    { id: "2", title: "明天天气" },
    { id: "3", title: "高数课在哪" },
  ]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
  const inputAreaRef = useRef<HTMLDivElement | null>(null);

  const getSessionId = () => {
    if (!sessionIdRef.current) {
      sessionIdRef.current = `sid_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    }
    return sessionIdRef.current;
  };

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

  const CurrentModeIcon = MODES.find(m => m.name === currentMode)?.icon || MessageCircle;
  const currentModeLabel = MODES.find(m => m.name === currentMode)?.label || "日常闲聊";

  const ChatInput = ({ variant }: { variant: "center" | "bottom" }) => {
    const isCenter = variant === "center";

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
                    <div className="relative" ref={modeMenuRef}>
                      <button
                        className="flex items-center gap-1 px-3 py-2 bg-white/60 dark:bg-gray-800/70 border border-gray-200/60 dark:border-gray-700/60 rounded-full text-gray-700 dark:text-gray-200 hover:bg-white/80 dark:hover:bg-gray-700/70 transition-colors"
                        onClick={toggleModeMenu}
                      >
                        <CurrentModeIcon size={16} />
                        <span className="text-sm font-medium">{currentMode}</span>
                        <ChevronDown size={14} className={`transition-transform duration-200 ${isModeMenuOpen ? 'rotate-180' : ''}`} />
                      </button>

                      {isModeMenuOpen && (
                        <div className="absolute bottom-full right-0 mb-3 w-56 bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl rounded-2xl shadow-xl border border-gray-100/70 dark:border-gray-700/70 overflow-hidden py-2 animate-in fade-in slide-in-from-bottom-4 z-50">
                          <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">切换模式</div>
                          {MODES.map((mode) => (
                            <button
                              key={mode.name}
                              className={`w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-gray-50/70 dark:hover:bg-gray-700/60 transition-colors ${currentMode === mode.name ? 'bg-blue-50/70 dark:bg-blue-900/20 text-blue-600' : 'text-gray-700 dark:text-gray-200'}`}
                              onClick={() => {
                                setCurrentMode(mode.name);
                                setIsModeMenuOpen(false);
                              }}
                            >
                              <div className={`p-1.5 rounded-lg ${currentMode === mode.name ? 'bg-blue-100/70 dark:bg-blue-800/60' : 'bg-gray-100/70 dark:bg-gray-700/60'}`}>
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

                    <div className="relative" ref={attachMenuRef}>
                      <button
                        className="p-2 bg-white/60 dark:bg-gray-800/70 border border-gray-200/60 dark:border-gray-700/60 rounded-full text-gray-600 dark:text-gray-300 hover:bg-white/80 dark:hover:bg-gray-700/70 transition-colors"
                        onClick={toggleAttachmentMenu}
                      >
                        <Plus size={20} className={`transition-transform duration-300 ${isAttachmentMenuOpen ? 'rotate-45' : ''}`} />
                      </button>

                      {isAttachmentMenuOpen && (
                        <div className="absolute bottom-full right-0 mb-3 w-48 bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl rounded-2xl shadow-xl border border-gray-100/70 dark:border-gray-700/70 overflow-hidden py-2 animate-in fade-in slide-in-from-bottom-4 z-50">
                          <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">上传</div>
                          <button className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50/70 dark:hover:bg-gray-700/60 transition-colors">
                            <ImageIcon size={16} />
                            <span>图片</span>
                          </button>
                          <button className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50/70 dark:hover:bg-gray-700/60 transition-colors">
                            <Table size={16} />
                            <span>表格</span>
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
  };

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
      const { reply } = await sendMessage(userMessage, getSessionId());
      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
      
      window.dispatchEvent(new CustomEvent("alice:emotion", {
        detail: { emotion: "happy", showBubble: true }
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

  return (
    <div className="flex h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans overflow-hidden">
      
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
              <h1 className="text-5xl font-medium bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 bg-clip-text text-transparent mb-2">
                你好, Sensei
              </h1>
              <h2 className="text-5xl font-medium text-gray-700 dark:text-gray-300 mb-12">
                今天想做点什么？
              </h2>

              <div className="w-full mt-2">
                <ChatInput variant="center" />
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto w-full py-8">
              {messages.map((msg, idx) => (
                <ChatMessage key={idx} role={msg.role} content={msg.content} />
              ))}
              {isLoading && (
                <div className="flex w-full mb-8 justify-start">
                   <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-400 to-blue-600 flex items-center justify-center mr-4 flex-shrink-0 shadow-sm text-white font-bold text-xs animate-pulse">
                      Aris
                   </div>
                   <div className="flex items-center h-8">
                     <div className="flex space-x-1">
                       <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                       <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                       <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                     </div>
                   </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {messages.length > 0 && <ChatInput variant="bottom" />}
      </div>

      {/* 右侧面板 */}
      <RightPanel
        isOpen={isRightPanelOpen}
        onToggle={() => setIsRightPanelOpen(!isRightPanelOpen)}
        currentMode={currentMode}
      />

      {/* 爱丽丝 Avatar (固定在右下角) */}
      <div className="fixed right-8 bottom-28 z-50 pointer-events-none">
        <div className="pointer-events-auto">
           <AliceAvatar />
        </div>
      </div>

    </div>
  );
}
