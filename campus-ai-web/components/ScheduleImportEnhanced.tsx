"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  Upload,
  Link,
  X,
  Check,
  Calendar,
  Clock,
  MapPin,
  User,
  Loader2,
  FileSpreadsheet,
  Edit3,
  Plus,
  Trash2,
  AlertCircle,
  HelpCircle,
} from "lucide-react";

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

interface ScheduleImportEnhancedProps {
  onScheduleImported?: (schedule: CourseItem[]) => void;
  onClose?: () => void;
  initialSchedule?: CourseItem[] | null;
}

const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WEEKDAY_OPTIONS = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 7, label: "周日" },
];

type ImportTab = "link" | "file" | "image" | "manual";

// 空白课程模板
const EMPTY_COURSE: Omit<CourseItem, "courseName"> = {
  instructor: null,
  location: null,
  weekday: 1,
  startTime: "08:00",
  endTime: "09:40",
  weeks: "1-16周",
};

export default function ScheduleImportEnhanced({
  onScheduleImported,
  onClose,
  initialSchedule,
}: ScheduleImportEnhancedProps) {
  const [activeTab, setActiveTab] = useState<ImportTab>("link");
  const [linkInput, setLinkInput] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<CourseItem[] | null>(initialSchedule || null);
  const [importSuccess, setImportSuccess] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  // 手动输入模式的临时数据
  const [manualCourses, setManualCourses] = useState<CourseItem[]>([
    { courseName: "", ...EMPTY_COURSE },
  ]);

  // 将原始错误文本格式化为 Alice 风格文案并保留 emotion 标签
  const formatAliceError = (raw: string) => {
    const lower = String(raw || '').toLowerCase();
    if (lower.includes('文件解析') || lower.includes('parse') || lower.includes('文件')) {
      return "[panicked] 呜哇... Sensei！这张卷轴（文件）上面的魔法符文太潦草了，爱丽丝解读不能！( >﹏<。) 能换一张清晰点的 PDF 重新咏唱吗？";
    }
    if (lower.includes('图片') || lower.includes('加载失败') || lower.includes('image')) {
      return "[dizzy] 糟糕！连接千年学园的通讯线路由于‘不明原因’断开了... (◎_◎;) 可能是服务器娘在打瞌睡，Sensei 我们稍后再试一次吧！";
    }
    if (lower.includes('不支持') || lower.includes('format') || lower.includes('格式')) {
      return "[thinking] 嗯... 这个格式好像不是勇者公会通用的卷轴呢。爱丽丝目前只能解读 PDF 和 ICS 哦！( •̀ ω •́ )y";
    }
    // fallback
    return `[sad] 抱歉，爱丽丝遇到了一点小麻烦：${raw}`;
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const excelInputRef = useRef<HTMLInputElement>(null);
  const icsInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // 从localStorage加载已有课表
  useEffect(() => {
    if (initialSchedule) {
      setSchedule(initialSchedule);
      return;
    }
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
  }, [initialSchedule]);

  // 模拟上传进度
  const simulateProgress = useCallback(() => {
    setUploadProgress(0);
    const interval = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 90) {
          clearInterval(interval);
          return prev;
        }
        return prev + Math.random() * 15;
      });
    }, 200);
    return () => clearInterval(interval);
  }, []);

  // 导入课表（链接/图片）
  const handleImport = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setImportSuccess(false);
    const stopProgress = simulateProgress();

    try {
      const body: Record<string, unknown> = {};

      if (activeTab === "link") {
        if (!linkInput.trim()) {
          throw new Error("请输入学习通课表链接");
        }
        body.url = linkInput.trim();
      } else if (activeTab === "image") {
        if (!imageUrl.trim()) {
          throw new Error("请输入课表图片URL或上传图片");
        }
        body.imageUrl = imageUrl.trim();
      } else if (activeTab === "manual") {
        const validCourses = manualCourses.filter((c) => c.courseName.trim());
        if (validCourses.length === 0) {
          throw new Error("请至少添加一门课程");
        }
        body.schedule = validCourses;
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

      setUploadProgress(100);

      // 保存到localStorage
      localStorage.setItem("campus_schedule", JSON.stringify(data.schedule));
      if (data.curriculumUuid) {
        localStorage.setItem("campus_curriculum_uuid", data.curriculumUuid);
      }
      setSchedule(data.schedule);
      setImportSuccess(true);

      // 通知父组件
      onScheduleImported?.(data.schedule);

      console.log(`✅ 课表导入成功 (来源: ${data.source}):`, data.schedule);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "导入失败";
      console.error('Schedule import error:', err);
      setError(formatAliceError(raw));
    } finally {
      stopProgress();
      setIsLoading(false);
    }
  }, [activeTab, linkInput, imageUrl, manualCourses, onScheduleImported, simulateProgress]);

  // 文件上传处理 - 图片
  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      setImageUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  // 通用文件处理函数（供拖拽和点击共用）
  const processFile = useCallback(
    async (file: File) => {
      setIsLoading(true);
      setError(null);
      const stopProgress = simulateProgress();

      try {
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch("/api/schedule/upload", {
          method: "POST",
          body: formData,
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || "文件解析失败");
        }

        setUploadProgress(100);
        localStorage.setItem("campus_schedule", JSON.stringify(data.schedule));
        setSchedule(data.schedule);
        setImportSuccess(true);
        onScheduleImported?.(data.schedule);

        console.log(`✅ 文件导入成功 (${file.name}):`, data.schedule);
      } catch (err) {
        const raw = err instanceof Error ? err.message : "文件解析失败";
        console.error("Schedule file upload error:", err);
        setError(formatAliceError(raw));
      } finally {
        stopProgress();
        setIsLoading(false);
      }
    },
    [onScheduleImported, simulateProgress]
  );

  // 文件上传处理 - Excel/ICS (点击)
  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await processFile(file);
    },
    [processFile]
  );

  // 拖拽事件处理
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = e.dataTransfer.files;
      if (files.length === 0) return;

      const file = files[0];
      const ext = file.name.toLowerCase().split(".").pop();

      // 判断文件类型并处理
      if (ext === "xlsx" || ext === "xls" || ext === "ics") {
        await processFile(file);
      } else if (file.type.startsWith("image/")) {
        // 图片文件
        const reader = new FileReader();
        reader.onload = () => {
          setImageUrl(reader.result as string);
          setActiveTab("image");
        };
        reader.readAsDataURL(file);
      } else {
        setError(formatAliceError(`不支持的文件格式: ${ext}`));
      }
    },
    [processFile]
  );

  // 清除课表
  const handleClear = useCallback(() => {
    localStorage.removeItem("campus_schedule");
    localStorage.removeItem("campus_curriculum_uuid");
    setSchedule(null);
    setImportSuccess(false);
  }, []);

  // 手动添加课程
  const addManualCourse = useCallback(() => {
    setManualCourses((prev) => [...prev, { courseName: "", ...EMPTY_COURSE }]);
  }, []);

  // 删除手动课程
  const removeManualCourse = useCallback((index: number) => {
    setManualCourses((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // 更新手动课程
  const updateManualCourse = useCallback(
    (index: number, field: keyof CourseItem, value: string | number | null) => {
      setManualCourses((prev) =>
        prev.map((course, i) => (i === index ? { ...course, [field]: value } : course))
      );
    },
    []
  );

  // 按星期分组
  const groupedSchedule = schedule?.reduce((acc, course) => {
    const day = course.weekday;
    if (!acc[day]) acc[day] = [];
    acc[day].push(course);
    return acc;
  }, {} as Record<number, CourseItem[]>);

  // Tab 配置
  const tabs: { key: ImportTab; label: string; icon: React.ReactNode; description: string }[] = [
    {
      key: "link",
      label: "学习通链接",
      icon: <Link className="w-4 h-4" />,
      description: "粘贴学习通课表分享链接",
    },
    {
      key: "file",
      label: "文件上传",
      icon: <FileSpreadsheet className="w-4 h-4" />,
      description: "上传 Excel (.xlsx/.xls) 或 ICS 文件",
    },
    {
      key: "image",
      label: "图片识别",
      icon: <Upload className="w-4 h-4" />,
      description: "上传课表截图，AI 自动识别",
    },
    {
      key: "manual",
      label: "手动输入",
      icon: <Edit3 className="w-4 h-4" />,
      description: "手动添加课程信息",
    },
  ];

  return (
    <div
      ref={dropZoneRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`bg-white dark:bg-gray-900 rounded-2xl shadow-xl border-2 ${
        isDragging
          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
          : "border-gray-200 dark:border-gray-700"
      } p-6 max-w-3xl mx-auto max-h-[90vh] overflow-y-auto transition-colors`}
    >
      {/* 拖拽提示遮罩 */}
      {isDragging && (
        <div className="absolute inset-0 bg-blue-500/10 dark:bg-blue-500/20 rounded-2xl flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center">
            <Upload className="w-12 h-12 text-blue-500 mx-auto mb-2" />
            <p className="text-blue-600 dark:text-blue-400 font-medium">
              松开鼠标导入文件
            </p>
            <p className="text-sm text-blue-500/80">
              支持 Excel / ICS / 图片
            </p>
          </div>
        </div>
      )}

      {/* 标题 */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
          <Calendar className="w-5 h-5 text-blue-500" />
          课表导入
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHelp(!showHelp)}
            className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full text-gray-500"
            title="帮助"
          >
            <HelpCircle className="w-5 h-5" />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full text-gray-500"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* 帮助提示 */}
      {showHelp && (
        <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
          <h4 className="font-medium text-blue-700 dark:text-blue-300 mb-2">📖 导入方式说明</h4>
          <ul className="space-y-1 text-blue-600 dark:text-blue-400">
            <li>
              <strong>学习通链接</strong>：打开学习通App → 课表 → 右上角分享 → 复制链接
            </li>
            <li>
              <strong>文件上传</strong>：支持教务系统导出的 Excel 或 ICS 日历文件
            </li>
            <li>
              <strong>图片识别</strong>：截图课表页面，AI 自动解析（准确率约 90%）
            </li>
            <li>
              <strong>手动输入</strong>：适合课程较少或需要微调的情况
            </li>
          </ul>
        </div>
      )}

      {/* Tab切换 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`py-2.5 px-3 rounded-lg font-medium transition-all flex flex-col items-center gap-1 text-sm ${
              activeTab === tab.key
                ? "bg-blue-500 text-white shadow-md"
                : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            {tab.icon}
            <span className="text-xs">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* 当前选项描述 */}
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {tabs.find((t) => t.key === activeTab)?.description}
      </p>

      {/* 输入区 */}
      <div className="mb-4">
        {activeTab === "link" && (
          <div>
            <input
              type="text"
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              placeholder="https://kb.chaoxing.com/res/pc/curriculum/schedule.html?curriculumUuid=..."
              className="w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <p className="mt-2 text-xs text-gray-500">
              打开学习通App → 课表 → 右上角&ldquo;分享&rdquo;图标 → 复制链接
            </p>
          </div>
        )}

        {activeTab === "file" && (
          <div className="space-y-3">
            {/* 拖拽区域提示 */}
            <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                💡 可以直接拖拽文件到此窗口任意位置导入
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => excelInputRef.current?.click()}
                className="flex-1 py-4 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg hover:border-blue-400 dark:hover:border-blue-500 transition-colors flex flex-col items-center gap-2"
              >
                <FileSpreadsheet className="w-8 h-8 text-green-500" />
                <span className="text-sm text-gray-600 dark:text-gray-300">上传 Excel</span>
                <span className="text-xs text-gray-400">.xlsx / .xls</span>
              </button>
              <button
                onClick={() => icsInputRef.current?.click()}
                className="flex-1 py-4 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg hover:border-blue-400 dark:hover:border-blue-500 transition-colors flex flex-col items-center gap-2"
              >
                <Calendar className="w-8 h-8 text-purple-500" />
                <span className="text-sm text-gray-600 dark:text-gray-300">上传 ICS</span>
                <span className="text-xs text-gray-400">日历文件</span>
              </button>
            </div>
            <input
              ref={excelInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileUpload}
              className="hidden"
            />
            <input
              ref={icsInputRef}
              type="file"
              accept=".ics"
              onChange={handleFileUpload}
              className="hidden"
            />
            <p className="text-xs text-gray-500">
              教务系统通常支持导出 Excel 课表；iOS/macOS 日历可导出 ICS 文件
            </p>
          </div>
        )}

        {activeTab === "image" && (
          <div>
            <div className="flex gap-2">
              <input
                type="text"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://example.com/schedule.png 或上传本地图片"
                className="flex-1 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-3 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                title="上传本地图片"
              >
                <Upload className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
              className="hidden"
            />
            {imageUrl && imageUrl.startsWith("data:") && (
              <div className="mt-2 text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
                <Check className="w-4 h-4" />
                已选择本地图片
              </div>
            )}
            {imageUrl && !imageUrl.startsWith("data:") && imageUrl.startsWith("http") && (
              <div className="mt-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt="预览"
                  className="max-h-32 rounded-lg border border-gray-200"
                  onError={() => {
                    console.error('Schedule image load error:', imageUrl);
                    setError(formatAliceError('图片加载失败，请检查URL'));
                  }}
                />
              </div>
            )}
          </div>
        )}

        {activeTab === "manual" && (
          <div className="space-y-3">
            {manualCourses.map((course, index) => (
              <div
                key={index}
                className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-500">课程 {index + 1}</span>
                  {manualCourses.length > 1 && (
                    <button
                      onClick={() => removeManualCourse(index)}
                      className="p-1 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-red-500"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={course.courseName}
                    onChange={(e) => updateManualCourse(index, "courseName", e.target.value)}
                    placeholder="课程名称 *"
                    className="px-3 py-2 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm"
                  />
                  <select
                    value={course.weekday}
                    onChange={(e) => updateManualCourse(index, "weekday", Number(e.target.value))}
                    className="px-3 py-2 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm"
                  >
                    {WEEKDAY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="time"
                    value={course.startTime}
                    onChange={(e) => updateManualCourse(index, "startTime", e.target.value)}
                    className="px-3 py-2 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm"
                  />
                  <input
                    type="time"
                    value={course.endTime}
                    onChange={(e) => updateManualCourse(index, "endTime", e.target.value)}
                    className="px-3 py-2 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm"
                  />
                  <input
                    type="text"
                    value={course.location || ""}
                    onChange={(e) => updateManualCourse(index, "location", e.target.value || null)}
                    placeholder="教室（选填）"
                    className="px-3 py-2 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm"
                  />
                  <input
                    type="text"
                    value={course.instructor || ""}
                    onChange={(e) => updateManualCourse(index, "instructor", e.target.value || null)}
                    placeholder="教师（选填）"
                    className="px-3 py-2 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm"
                  />
                </div>
              </div>
            ))}
            <button
              onClick={addManualCourse}
              className="w-full py-2 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-500 hover:border-blue-400 hover:text-blue-500 transition-colors flex items-center justify-center gap-1"
            >
              <Plus className="w-4 h-4" />
              添加课程
            </button>
          </div>
        )}
      </div>

      {/* 进度条 */}
      {isLoading && (
        <div className="mb-4">
          <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-1 text-center">
            {uploadProgress < 100 ? "正在解析..." : "解析完成"}
          </p>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
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

      {/* 已有课表时的提示 */}
      {schedule && schedule.length > 0 && !importSuccess && (
        <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-amber-600 dark:text-amber-400 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          已有 {schedule.length} 门课程。如需重新导入，请先点击"清除"按钮。
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex gap-2 mb-6">
        {activeTab !== "file" && (
          <button
            onClick={handleImport}
            disabled={isLoading || !!schedule?.length}
            className="flex-1 py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                解析中...
              </>
            ) : schedule?.length ? (
              <>
                <AlertCircle className="w-4 h-4" />
                已有课表
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                导入课表
              </>
            )}
          </button>
        )}
        {schedule && (
          <button
            onClick={handleClear}
            className="px-4 py-3 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg transition-colors flex items-center gap-1"
          >
            <Trash2 className="w-4 h-4" />
            清除
          </button>
        )}
      </div>

      {/* 课表预览 */}
      {schedule && schedule.length > 0 && (
        <div>
          <h3 className="text-lg font-medium text-gray-800 dark:text-gray-100 mb-3 flex items-center gap-2">
            <Calendar className="w-4 h-4" />
            课表预览 ({schedule.length} 门课)
          </h3>
          <div className="space-y-4 max-h-64 overflow-y-auto">
            {Object.entries(groupedSchedule || {})
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([day, courses]) => (
                <div key={day}>
                  <div className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-2">
                    <span className="w-1 h-4 bg-blue-500 rounded-full"></span>
                    {WEEKDAY_NAMES[Number(day)]}
                    <span className="text-xs text-gray-400">({(courses as CourseItem[]).length}门)</span>
                  </div>
                  <div className="space-y-2">
                    {(courses as CourseItem[])
                      .sort((a, b) => a.startTime.localeCompare(b.startTime))
                      .map((course, idx) => (
                        <div
                          key={idx}
                          className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700 hover:shadow-sm transition-shadow"
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

      {/* 无课表提示 */}
      {!schedule && !isLoading && (
        <div className="text-center py-8 text-gray-500">
          <Calendar className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p>还没有导入课表</p>
          <p className="text-sm mt-1">选择上方任一方式导入你的课表</p>
        </div>
      )}
    </div>
  );
}
