"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { Upload, Link, X, Check, Calendar, Clock, MapPin, User, Loader2 } from "lucide-react";

// 课程数据类型
interface CourseItem {
  courseName: string;
  instructor: string | null;
  location: string | null;
  weekday: number;
  startTime: string;
  endTime: string;
  weeks: string | null;
}

interface ScheduleImportProps {
  onScheduleImported?: (schedule: CourseItem[]) => void;
  onClose?: () => void;
}

const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export default function ScheduleImport({ onScheduleImported, onClose }: ScheduleImportProps) {
  const [activeTab, setActiveTab] = useState<"link" | "image">("link");
  const [linkInput, setLinkInput] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<CourseItem[] | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 从localStorage加载已有课表
  useEffect(() => {
    const saved = localStorage.getItem("campus_schedule");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setSchedule(parsed);
        }
      } catch {
        // ignore
      }
    }
  }, []);

  // 导入课表
  const handleImport = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setImportSuccess(false);

    try {
      const body: Record<string, string> = {};
      
      if (activeTab === "link") {
        if (!linkInput.trim()) {
          throw new Error("请输入学习通课表链接");
        }
        body.url = linkInput.trim();
      } else {
        if (!imageUrl.trim()) {
          throw new Error("请输入课表图片URL或上传图片");
        }
        body.imageUrl = imageUrl.trim();
      }

      const response = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "导入失败");
      }

      // 保存到localStorage
      localStorage.setItem("campus_schedule", JSON.stringify(data.schedule));
      // 🆕 保存 curriculumUuid 供跨周动态查询
      if (data.curriculumUuid) {
        localStorage.setItem("campus_curriculum_uuid", data.curriculumUuid);
      }
      setSchedule(data.schedule);
      setImportSuccess(true);
      
      // 通知父组件
      onScheduleImported?.(data.schedule);

      // 打印到console供验证
      console.log("✅ 课表解析成功:", data.schedule);
      data.schedule.forEach((course: CourseItem, index: number) => {
        console.log(`课程 ${index + 1}:`, {
          weekday: course.weekday,
          course: course.courseName,
          time: `${course.startTime}-${course.endTime}`,
          location: course.location,
          teacher: course.instructor,
        });
      });

    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setIsLoading(false);
    }
  }, [activeTab, linkInput, imageUrl, onScheduleImported]);

  // 文件上传处理
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 转为base64（简化处理，实际应上传到云存储）
    const reader = new FileReader();
    reader.onload = () => {
      setImageUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  // 清除课表
  const handleClear = useCallback(() => {
    localStorage.removeItem("campus_schedule");
    setSchedule(null);
    setImportSuccess(false);
  }, []);

  // 按星期分组
  const groupedSchedule = schedule?.reduce((acc, course) => {
    const day = course.weekday;
    if (!acc[day]) acc[day] = [];
    acc[day].push(course);
    return acc;
  }, {} as Record<number, CourseItem[]>);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 p-6 max-w-2xl mx-auto">
      {/* 标题 */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
          <Calendar className="w-5 h-5 text-blue-500" />
          课表导入
        </h2>
        {onClose && (
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        )}
      </div>

      {/* Tab切换 */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setActiveTab("link")}
          className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${
            activeTab === "link"
              ? "bg-blue-500 text-white"
              : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
          }`}
        >
          <Link className="w-4 h-4" />
          学习通链接
        </button>
        <button
          onClick={() => setActiveTab("image")}
          className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${
            activeTab === "image"
              ? "bg-blue-500 text-white"
              : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
          }`}
        >
          <Upload className="w-4 h-4" />
          图片识别
        </button>
      </div>

      {/* 输入区 */}
      <div className="mb-4">
        {activeTab === "link" ? (
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-2">
              粘贴学习通课表分享链接
            </label>
            <input
              type="text"
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              placeholder="https://kb.chaoxing.com/res/pc/curriculum/schedule.html?curriculumUuid=..."
              className="w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
        ) : (
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-2">
              上传课表截图或输入图片URL
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://example.com/schedule.png"
                className="flex-1 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-3 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                <Upload className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileUpload}
                className="hidden"
              />
            </div>
            {imageUrl && imageUrl.startsWith("data:") && (
              <div className="mt-2 text-sm text-green-600 dark:text-green-400">
                ✓ 已选择本地图片
              </div>
            )}
          </div>
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* 成功提示 */}
      {importSuccess && (
        <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-green-600 dark:text-green-400 text-sm flex items-center gap-2">
          <Check className="w-4 h-4" />
          解析成功！共导入 {schedule?.length} 门课程
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={handleImport}
          disabled={isLoading}
          className="flex-1 py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              解析中...
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              导入课表
            </>
          )}
        </button>
        {schedule && (
          <button
            onClick={handleClear}
            className="px-4 py-3 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg transition-colors"
          >
            清除
          </button>
        )}
      </div>

      {/* 课表预览 */}
      {schedule && schedule.length > 0 && (
        <div>
          <h3 className="text-lg font-medium text-gray-800 dark:text-gray-100 mb-3 flex items-center gap-2">
            <Calendar className="w-4 h-4" />
            课表预览
          </h3>
          <div className="space-y-4 max-h-80 overflow-y-auto">
            {Object.entries(groupedSchedule || {})
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([day, courses]) => (
                <div key={day}>
                  <div className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
                    {WEEKDAY_NAMES[Number(day)]}
                  </div>
                  <div className="space-y-2">
                    {(courses as CourseItem[])
                      .sort((a, b) => a.startTime.localeCompare(b.startTime))
                      .map((course, idx) => (
                        <div
                          key={idx}
                          className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700"
                        >
                          <div className="font-medium text-gray-800 dark:text-gray-100">
                            {course.courseName}
                          </div>
                          <div className="flex flex-wrap gap-3 mt-1 text-sm text-gray-500 dark:text-gray-400">
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {course.startTime}-{course.endTime}
                            </span>
                            {course.location && (
                              <span className="flex items-center gap-1">
                                <MapPin className="w-3 h-3" />
                                {course.location}
                              </span>
                            )}
                            {course.instructor && (
                              <span className="flex items-center gap-1">
                                <User className="w-3 h-3" />
                                {course.instructor}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
