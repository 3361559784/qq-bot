import React from 'react';
import { Calendar, Clock, MapPin, CloudRain, Sun, AlertCircle } from 'lucide-react';

interface PlanItem {
  time: string;
  title: string;
  location?: string;
  type: 'class' | 'study' | 'activity' | 'break';
}

interface PlanViewProps {
  planContent: string;
}

/**
 * Plan模式展示组件
 * 解析并美化显示智能计划
 */
export default function PlanView({ planContent }: PlanViewProps) {
  // 解析计划内容 (简单版本,可根据实际返回格式调整)
  const parsePlanItems = (content: string): PlanItem[] => {
    const items: PlanItem[] = [];
    const lines = content.split('\n');
    
    lines.forEach(line => {
      // 匹配时间格式: "9:00-11:00 数学课 @ 教学楼A101"
      const match = line.match(/(\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?)\s+(.+?)(?:\s+@\s+(.+))?$/);
      if (match) {
        items.push({
          time: match[1],
          title: match[2].trim(),
          location: match[3]?.trim(),
          type: determineType(match[2])
        });
      }
    });
    
    return items;
  };

  const determineType = (title: string): PlanItem['type'] => {
    if (title.includes('课') || title.includes('Class')) return 'class';
    if (title.includes('自习') || title.includes('学习')) return 'study';
    if (title.includes('休息') || title.includes('午休')) return 'break';
    return 'activity';
  };

  // 提取天气提示
  const weatherTip = planContent.match(/☂️.*|🌞.*|🌧️.*|⛈️.*/)?.[0];

  const planItems = parsePlanItems(planContent);

  // 如果没有解析到结构化数据,显示原始文本
  if (planItems.length === 0) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 mb-4">
            <Calendar className="w-5 h-5 text-blue-500" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              📅 今日计划
            </h3>
          </div>
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700 dark:text-gray-300">
            {planContent}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Calendar className="w-6 h-6 text-blue-500" />
          <h3 className="text-xl font-bold text-gray-900 dark:text-white">
            📅 今日智能计划
          </h3>
        </div>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {new Date().toLocaleDateString('zh-CN', { 
            month: 'long', 
            day: 'numeric',
            weekday: 'long' 
          })}
        </span>
      </div>

      {/* 天气提示 */}
      {weatherTip && (
        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg flex items-center gap-3">
          {weatherTip.includes('☂️') || weatherTip.includes('🌧️') ? (
            <CloudRain className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          ) : (
            <Sun className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
          )}
          <span className="text-sm text-blue-700 dark:text-blue-300">
            {weatherTip}
          </span>
        </div>
      )}

      {/* 计划时间轴 */}
      <div className="relative">
        {/* 时间轴线 */}
        <div className="absolute left-[29px] top-0 bottom-0 w-0.5 bg-gray-200 dark:bg-gray-700"></div>

        {planItems.map((item, idx) => (
          <div key={idx} className="relative pl-16 pb-6 last:pb-0">
            {/* 时间轴圆点 */}
            <div className={`absolute left-6 top-2 w-3 h-3 rounded-full border-2 ${
              item.type === 'class' 
                ? 'bg-blue-500 border-blue-600' 
                : item.type === 'study'
                ? 'bg-green-500 border-green-600'
                : item.type === 'break'
                ? 'bg-gray-400 border-gray-500'
                : 'bg-purple-500 border-purple-600'
            }`}></div>

            {/* 内容卡片 */}
            <div className="p-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="w-4 h-4 text-gray-500" />
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                      {item.time}
                    </span>
                    <span className={`px-2 py-0.5 text-xs rounded-full ${
                      item.type === 'class'
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                        : item.type === 'study'
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                        : item.type === 'break'
                        ? 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                        : 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                    }`}>
                      {item.type === 'class' ? '课程' : item.type === 'study' ? '学习' : item.type === 'break' ? '休息' : '活动'}
                    </span>
                  </div>
                  <h4 className="text-base font-semibold text-gray-900 dark:text-white mb-1">
                    {item.title}
                  </h4>
                  {item.location && (
                    <div className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
                      <MapPin className="w-4 h-4" />
                      <span>{item.location}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 底部提示 */}
      <div className="flex items-start gap-2 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
        <AlertCircle className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
        <p className="text-sm text-gray-600 dark:text-gray-400">
          计划已根据你的课表和当前天气自动生成。如需调整,请告诉我你的想法 (✨ω✨)
        </p>
      </div>
    </div>
  );
}
