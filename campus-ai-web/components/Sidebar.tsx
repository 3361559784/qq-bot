"use client";

import React from "react";
import { Plus, MessageCircle, X } from "lucide-react";

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  conversations: Array<{ id: string; title: string }>;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
}

export default function Sidebar({ isOpen, onToggle, conversations, onNewChat, onSelectChat }: SidebarProps) {
  return (
    <>
      {/* 移动端遮罩层 */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onToggle}
        />
      )}
      
      {/* 侧边栏主体 */}
      <div
        className={`fixed left-0 top-0 h-full bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 transition-transform duration-300 z-50 w-64 shadow-xl ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex flex-col h-full p-4 w-64">
          {/* 标题与关闭按钮 */}
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg text-gray-800 dark:text-gray-100">Tendon Arisu</h2>
            <button
              onClick={onToggle}
              className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 lg:hidden"
              title="关闭"
            >
              <X size={20} />
            </button>
          </div>

          {/* 新对话按钮 */}
          <button
            onClick={() => {
              onNewChat();
              if (window.innerWidth < 1024) onToggle(); // 移动端自动关闭
            }}
            className="flex items-center gap-2 w-full px-4 py-3 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded-xl transition-colors mb-6 text-gray-800 dark:text-gray-100"
          >
            <Plus size={20} />
            <span className="font-medium">新对话</span>
          </button>

          {/* 最近对话 */}
          <div className="flex-1 overflow-y-auto">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 px-2">最近</p>
            <div className="space-y-1">
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => {
                    onSelectChat(conv.id);
                    if (window.innerWidth < 1024) onToggle(); // 移动端自动关闭
                  }}
                  className="flex items-center gap-3 w-full px-3 py-2.5 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors text-left text-gray-700 dark:text-gray-300"
                >
                  <MessageCircle size={16} className="text-gray-500 flex-shrink-0" />
                  <span className="text-sm truncate">{conv.title}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
