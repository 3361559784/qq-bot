"use client";

import React, { useState, useEffect, useCallback } from "react";
import { X, Calendar, Cloud, Clock, Upload, RefreshCw } from "lucide-react";

interface CourseItem {
  courseName: string;
  instructor: string | null;
  location: string | null;
  weekday: number;
  startTime: string;
  endTime: string;
  weeks: string | null;
}

interface RightPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  currentMode: string;
  onOpenImport?: () => void;
}

// 星期映射
const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export default function RightPanel({ isOpen, onToggle, currentMode, onOpenImport }: RightPanelProps) {
  const [schedule, setSchedule] = useState<CourseItem[]>([]);
  const [todayCourses, setTodayCourses] = useState<CourseItem[]>([]);
  const [nextCourse, setNextCourse] = useState<{ course: CourseItem; remaining: string } | null>(null);
  const [hasSchedule, setHasSchedule] = useState(false);

  // 计算下一节课
  const calculateNextCourse = useCallback((courses: CourseItem[]) => {
    const now = new Date();
    const today = now.getDay() || 7;
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    
    // 今日还未上的课
    let next = courses
      .filter((c: CourseItem) => c.weekday === today && c.startTime > currentTime)
      .sort((a: CourseItem, b: CourseItem) => a.startTime.localeCompare(b.startTime))[0];
    
    // 如果今天没有了，找下一个有课的日子
    if (!next) {
      for (let i = 1; i <= 7; i++) {
        const nextDay = ((today - 1 + i) % 7) + 1;
        const nextDayCourses = courses
          .filter((c: CourseItem) => c.weekday === nextDay)
          .sort((a: CourseItem, b: CourseItem) => a.startTime.localeCompare(b.startTime));
        if (nextDayCourses.length > 0) {
          next = nextDayCourses[0];
          break;
        }
      }
    }
    
    if (next) {
      // 计算剩余时间
      const [h, m] = next.startTime.split(':').map(Number);
      const courseTime = new Date(now);
      
      // 如果是其他天的课
      if (next.weekday !== today) {
        const daysUntil = ((next.weekday - today + 7) % 7) || 7;
        courseTime.setDate(courseTime.getDate() + daysUntil);
      }
      courseTime.setHours(h, m, 0, 0);
      
      const diff = courseTime.getTime() - now.getTime();
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      
      let remaining = '';
      if (hours > 24) {
        remaining = `${WEEKDAY_NAMES[next.weekday]} ${next.startTime}`;
      } else if (hours > 0) {
        remaining = `还有 ${hours}小时${minutes}分钟`;
      } else {
        remaining = `还有 ${minutes}分钟`;
      }
      
      setNextCourse({ course: next, remaining });
    } else {
      setNextCourse(null);
    }
  }, []);

  // 从 localStorage 加载课表
  const loadSchedule = useCallback(() => {
    if (typeof window === 'undefined') return;
    
    try {
      const saved = localStorage.getItem('campus_schedule');
      if (saved) {
        const data = JSON.parse(saved);
        const courses = data.schedule || [];
        setSchedule(courses);
        setHasSchedule(courses.length > 0);
        
        // 计算今日课程
        const today = new Date().getDay() || 7; // 0=周日 -> 7
        const todayList = courses
          .filter((c: CourseItem) => c.weekday === today)
          .sort((a: CourseItem, b: CourseItem) => a.startTime.localeCompare(b.startTime));
        setTodayCourses(todayList);
        
        // 计算下一节课
        calculateNextCourse(courses);
      } else {
        setHasSchedule(false);
        setTodayCourses([]);
        setNextCourse(null);
      }
    } catch (e) {
      console.error('加载课表失败:', e);
    }
  }, [calculateNextCourse]);

  // 初始加载
  useEffect(() => {
    // 使用 setTimeout 避免在 effect 中同步调用 setState
    const timeoutId = setTimeout(() => {
      loadSchedule();
    }, 0);
    
    return () => clearTimeout(timeoutId);
  }, [loadSchedule]);

  // 定时刷新和监听 storage
  useEffect(() => {
    // 每分钟更新一次下一节课倒计时
    const timer = setInterval(() => {
      if (schedule.length > 0) {
        calculateNextCourse(schedule);
      }
    }, 60000);
    
    // 监听 storage 变化（其他页面导入课表时）
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'campus_schedule') {
        loadSchedule();
      }
    };
    window.addEventListener('storage', handleStorage);
    
    return () => {
      clearInterval(timer);
      window.removeEventListener('storage', handleStorage);
    };
  }, [loadSchedule, schedule, calculateNextCourse]);

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
            <div className="flex items-center gap-1">
              <button
                onClick={loadSchedule}
                className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
                title="刷新"
              >
                <RefreshCw size={16} />
              </button>
              <button
                onClick={onToggle}
                className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 lg:hidden"
                title="关闭"
              >
                <X size={20} />
              </button>
            </div>
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

            {/* 今日课表 - Class 模式 */}
            {currentMode === "Class" && (
              <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Calendar size={16} className="text-gray-500" />
                    <span className="font-medium">今日课表</span>
                  </div>
                  {onOpenImport && (
                    <button
                      onClick={onOpenImport}
                      className="text-xs text-blue-500 hover:text-blue-600 flex items-center gap-1"
                    >
                      <Upload size={12} />
                      导入
                    </button>
                  )}
                </div>
                
                {!hasSchedule ? (
                  <div className="text-center py-4">
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">暂无课表数据</p>
                    {onOpenImport && (
                      <button
                        onClick={onOpenImport}
                        className="text-sm text-blue-500 hover:text-blue-600 flex items-center gap-1 mx-auto"
                      >
                        <Upload size={14} />
                        点击导入课表
                      </button>
                    )}
                  </div>
                ) : todayCourses.length === 0 ? (
                  <div className="text-center py-4">
                    <p className="text-sm text-gray-500 dark:text-gray-400">🎉 今天没有课程</p>
                  </div>
                ) : (
                  <div className="space-y-2 text-sm max-h-48 overflow-y-auto">
                    {todayCourses.map((course, idx) => (
                      <div key={idx} className="p-2 bg-gray-50 dark:bg-gray-900 rounded">
                        <p className="font-medium">{course.startTime} - {course.endTime}</p>
                        <p className="text-gray-600 dark:text-gray-400">
                          {course.courseName}
                          {course.location && ` · ${course.location}`}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 下一节课 - Class 模式 */}
            {currentMode === "Class" && nextCourse && (
              <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-3">
                  <Clock size={16} className="text-gray-500" />
                  <span className="font-medium">下一节课</span>
                </div>
                <div className="text-sm">
                  <p className="font-medium">{nextCourse.course.courseName}</p>
                  <p className="text-gray-600 dark:text-gray-400">{nextCourse.remaining}</p>
                  {nextCourse.course.location && (
                    <p className="text-gray-600 dark:text-gray-400">地点: {nextCourse.course.location}</p>
                  )}
                </div>
              </div>
            )}

            {/* 天气卡片 - Plan 模式 */}
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

            {/* 建议 - Ask 模式 */}
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

            {/* 课表快捷入口 - 非 Class 模式 */}
            {currentMode !== "Class" && !hasSchedule && (
              <div className="p-4 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-800">
                <div className="flex items-center gap-2 mb-2">
                  <Calendar size={16} className="text-amber-600" />
                  <span className="font-medium text-amber-700 dark:text-amber-300">课表提醒</span>
                </div>
                <p className="text-sm text-amber-600 dark:text-amber-400 mb-2">
                  还没有导入课表，导入后可以查询课程安排
                </p>
                {onOpenImport && (
                  <button
                    onClick={onOpenImport}
                    className="text-sm text-amber-700 hover:text-amber-800 dark:text-amber-300 flex items-center gap-1"
                  >
                    <Upload size={14} />
                    立即导入
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
