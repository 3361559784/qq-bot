import React from 'react';
import { ExternalLink, Zap, Database, Cloud, DollarSign, Brain } from 'lucide-react';

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

interface SearchResultsProps {
  reply: string;
}

/**
 * 搜索来源徽章组件
 */
function SearchSourceBadge({ source }: { source: string }) {
  const sourceConfig: Record<string, { icon: any; color: string; bgColor: string; label: string }> = {
    'cache': { 
      icon: Zap, 
      color: 'text-green-600 dark:text-green-400', 
      bgColor: 'bg-green-50 dark:bg-green-900/20',
      label: '缓存' 
    },
    'local': { 
      icon: Database, 
      color: 'text-blue-600 dark:text-blue-400', 
      bgColor: 'bg-blue-50 dark:bg-blue-900/20',
      label: '本地' 
    },
    'duckduckgo': { 
      icon: Cloud, 
      color: 'text-purple-600 dark:text-purple-400', 
      bgColor: 'bg-purple-50 dark:bg-purple-900/20',
      label: 'DuckDuckGo' 
    },
    'serpapi': { 
      icon: DollarSign, 
      color: 'text-yellow-600 dark:text-yellow-400', 
      bgColor: 'bg-yellow-50 dark:bg-yellow-900/20',
      label: 'SerpAPI' 
    },
    'llm': { 
      icon: Brain, 
      color: 'text-red-600 dark:text-red-400', 
      bgColor: 'bg-red-50 dark:bg-red-900/20',
      label: 'AI生成' 
    }
  };
  
  const normalizedSource = source.toLowerCase().replace('cache-', '');
  const config = sourceConfig[normalizedSource] || sourceConfig['llm'];
  const Icon = config.icon;
  
  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${config.color} ${config.bgColor} border border-current/20`}>
      <Icon size={14} />
      <span>{config.label}</span>
    </div>
  );
}

/**
 * 搜索结果展示组件
 * 解析后端返回的搜索结果并美化展示
 */
export default function SearchResults({ reply }: SearchResultsProps) {
  // 提取来源信息
  const sourceMatch = reply.match(/\(来源:\s*([^,\)]+)(?:,\s*([^\)]+))?\)/);
  const searchSource = sourceMatch?.[1]?.trim() || 'unknown';
  const cacheStatus = sourceMatch?.[2]?.trim();
  
  // 正则解析搜索结果 (格式: 1. 【标题】\n   摘要...\n   🔗 URL)
  const regex = /(\d+)\.\s*【(.+?)】\s+(.+?)\s+🔗\s+(https?:\/\/[^\s\n]+)/g;
  const results: SearchResult[] = [];
  let match;
  
  while ((match = regex.exec(reply)) !== null) {
    results.push({
      title: match[2].trim(),
      snippet: match[3].trim(),
      url: match[4].trim()
    });
  }
  
  // 如果没有搜索结果,显示纯文本
  if (results.length === 0) {
    return (
      <div className="px-4 py-2 rounded-xl max-w-2xl bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100">
        <pre className="whitespace-pre-wrap font-sans text-sm">{reply}</pre>
      </div>
    );
  }
  
  return (
    <div className="max-w-3xl space-y-3">
      {/* 来源标签 */}
      <div className="flex items-center gap-2 mb-2">
        <SearchSourceBadge source={searchSource} />
        {cacheStatus && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {cacheStatus}
          </span>
        )}
      </div>
      
      {/* 搜索结果列表 */}
      {results.map((result, idx) => (
        <a
          key={idx}
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block p-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md hover:border-blue-400 dark:hover:border-blue-500 transition-all group"
        >
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              {/* 标题 */}
              <h3 className="font-semibold text-blue-600 dark:text-blue-400 mb-2 flex items-center gap-2 group-hover:underline">
                <span className="text-gray-500 dark:text-gray-400 font-normal">
                  {idx + 1}.
                </span>
                <span className="truncate">{result.title}</span>
              </h3>
              
              {/* 摘要 */}
              <p className="text-sm text-gray-700 dark:text-gray-300 line-clamp-2 leading-relaxed">
                {result.snippet}
              </p>
              
              {/* URL */}
              <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 truncate">
                {result.url}
              </div>
            </div>
            
            {/* 外链图标 */}
            <ExternalLink 
              size={18} 
              className="text-gray-400 dark:text-gray-500 mt-1 flex-shrink-0 group-hover:text-blue-500 transition" 
            />
          </div>
        </a>
      ))}
      
      {/* 底部提示 */}
      <div className="text-xs text-gray-500 dark:text-gray-400 text-center pt-2">
        共找到 {results.length} 条结果
      </div>
    </div>
  );
}
