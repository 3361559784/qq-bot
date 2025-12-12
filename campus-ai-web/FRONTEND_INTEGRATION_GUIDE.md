# 🎨 Campus AI Web - 搜索模块前端集成指南

## 📌 架构总览

```
用户输入 → Next.js Frontend → /api/chat → Azure Function (schoolBot) → 搜索模块
           ↓                                        ↓
     UI展示结果  ←────────── JSON响应 ←───── hybridSearch返回
```

---

## 🔧 集成步骤

### 步骤1: 配置环境变量

在 `campus-ai-web/.env.local` 创建配置:

```bash
# Azure Function后端地址
NEXT_PUBLIC_AZURE_FUNCTION_URL=https://your-bot.azurewebsites.net/api/schoolBot

# 或本地开发时使用
NEXT_PUBLIC_AZURE_FUNCTION_URL=http://localhost:7071/api/schoolBot

# OpenAI API Key (可选,如果需要本地LLM降级)
OPENAI_API_KEY=sk-xxx
```

---

### 步骤2: 理解后端API格式

#### 请求格式 (发送到Azure Function)

```typescript
POST /api/schoolBot
Content-Type: application/json

{
  "post_type": "message",
  "message_type": "private",
  "user_id": 888888888,         // 前端用户ID
  "message": "百科:人工智能"     // 触发搜索的关键词
}
```

#### 响应格式

```json
{
  "reply": "📚 关于 \"人工智能\" 的搜索结果 (来源: DuckDuckGo, 缓存):\n\n1. 【人工智能 - 维基百科】\n   人工智能（AI）是计算机科学的一个分支...\n   🔗 https://zh.wikipedia.org/wiki/人工智能\n\n2. 【什么是人工智能】\n   AI技术的核心应用包括...\n   🔗 https://example.com/ai-intro\n\n...",
  "auto_escape": false
}
```

---

### 步骤3: 前端API路由改造

#### 方案A: 直接代理到Azure Function (推荐)

修改 `app/api/chat/route.ts`:

```typescript
export const runtime = 'edge';

export async function POST(req: Request) {
  const { messages } = await req.json();
  
  // 获取最后一条用户消息
  const lastMessage = messages[messages.length - 1];
  const userMessage = lastMessage?.content || '';
  
  // 调用Azure Function后端
  const azureFunctionUrl = process.env.NEXT_PUBLIC_AZURE_FUNCTION_URL || 
    'http://localhost:7071/api/schoolBot';
  
  const response = await fetch(azureFunctionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      user_id: 888888888, // 可从session/auth获取真实用户ID
      message: `百科:${userMessage}` // 自动添加"百科:"前缀触发搜索
    })
  });
  
  const data = await response.json();
  
  // 返回兼容Vercel AI SDK的格式
  return new Response(data.reply, {
    headers: { 'Content-Type': 'text/plain' }
  });
}
```

#### 方案B: 流式响应 (支持打字机效果)

```typescript
import { OpenAI } from 'openai';
import { OpenAIStream, StreamingTextResponse } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();
  const lastMessage = messages[messages.length - 1];
  
  // 1. 先调用Azure Function获取搜索结果
  const azureResponse = await fetch(process.env.NEXT_PUBLIC_AZURE_FUNCTION_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      user_id: 888888888,
      message: `百科:${lastMessage.content}`
    })
  });
  
  const { reply } = await azureResponse.json();
  
  // 2. 使用OpenAI流式返回结果
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const stream = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    stream: true,
    messages: [
      { role: 'system', content: 'You are Alice. Format search results elegantly.' },
      { role: 'assistant', content: reply }
    ],
  });
  
  return new StreamingTextResponse(OpenAIStream(stream));
}
```

---

### 步骤4: 前端UI组件增强

#### 创建搜索结果解析组件 `components/SearchResults.tsx`:

```typescript
import React from 'react';
import { ExternalLink } from 'lucide-react';

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

export default function SearchResults({ reply }: { reply: string }) {
  // 正则解析搜索结果
  const regex = /\d+\.\s*【(.+?)】\s+(.+?)\s+🔗\s+(https?:\/\/.+?)(?=\n|$)/g;
  const results: SearchResult[] = [];
  let match;
  
  while ((match = regex.exec(reply)) !== null) {
    results.push({
      title: match[1],
      snippet: match[2].trim(),
      url: match[3]
    });
  }
  
  if (results.length === 0) {
    return <div className="text-gray-600">{reply}</div>;
  }
  
  return (
    <div className="space-y-4">
      {results.map((result, idx) => (
        <div key={idx} className="p-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition">
          <a 
            href={result.url} 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-start gap-2"
          >
            <div className="flex-1">
              <h3 className="font-semibold text-blue-600 dark:text-blue-400 mb-1">
                {idx + 1}. {result.title}
              </h3>
              <p className="text-sm text-gray-700 dark:text-gray-300 line-clamp-2">
                {result.snippet}
              </p>
            </div>
            <ExternalLink size={18} className="text-gray-400 mt-1 flex-shrink-0" />
          </a>
        </div>
      ))}
    </div>
  );
}
```

#### 在 `app/page.tsx` 中使用:

```typescript
import SearchResults from '../components/SearchResults';

// 在消息渲染处:
{messages.map((msg: any, idx: number) => (
  <div key={idx} className={`mb-4 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
    {msg.role === "assistant" ? (
      <SearchResults reply={msg.content} />
    ) : (
      <div className="px-4 py-2 rounded-xl max-w-xl bg-blue-600 text-white">
        {msg.content}
      </div>
    )}
  </div>
))}
```

---

### 步骤5: 添加搜索来源指示器

创建 `components/SearchSourceBadge.tsx`:

```typescript
import React from 'react';
import { Database, Cloud, Zap, DollarSign, Brain } from 'lucide-react';

export default function SearchSourceBadge({ source }: { source: string }) {
  const sourceConfig: Record<string, { icon: any; color: string; label: string }> = {
    'cache': { icon: Zap, color: 'text-green-500', label: '缓存' },
    'local': { icon: Database, color: 'text-blue-500', label: '本地' },
    'duckduckgo': { icon: Cloud, color: 'text-purple-500', label: 'DDG' },
    'serpapi': { icon: DollarSign, color: 'text-yellow-500', label: 'SerpAPI' },
    'llm': { icon: Brain, color: 'text-red-500', label: 'LLM' }
  };
  
  const config = sourceConfig[source.toLowerCase()] || sourceConfig['llm'];
  const Icon = config.icon;
  
  return (
    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs ${config.color} bg-opacity-10`}>
      <Icon size={14} />
      <span>{config.label}</span>
    </div>
  );
}
```

---

### 步骤6: 搜索模式切换

在 `app/page.tsx` 侧边栏添加搜索模式:

```typescript
const MODES = [
  { name: "Plan", icon: Plan },
  { name: "Search", icon: Search }, // 新增搜索模式
  { name: "Ask", icon: MessageCircle },
  { name: "Class", icon: BookOpen },
];
```

---

## 🧪 本地测试步骤

### 1. 启动后端Azure Function

```bash
cd /Users/liuziheng/qq-bot-aris-clean
func start
# 后端应运行在 http://localhost:7071
```

### 2. 启动前端开发服务器

```bash
cd campus-ai-web
npm install
npm run dev
# 前端应运行在 http://localhost:3000
```

### 3. 测试流程

1. 打开浏览器访问 `http://localhost:3000`
2. 在聊天框输入 `人工智能`
3. 前端自动添加 `百科:` 前缀
4. 后端返回搜索结果
5. 前端解析并展示结构化结果

---

## 📊 性能优化建议

### 1. 添加加载状态

```typescript
const [isSearching, setIsSearching] = useState(false);

async function handleSearch(query: string) {
  setIsSearching(true);
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: query }] })
    });
    const data = await response.json();
    // 处理结果
  } finally {
    setIsSearching(false);
  }
}
```

### 2. 添加错误处理

```typescript
const [error, setError] = useState<string | null>(null);

try {
  const response = await fetch('/api/chat', { /* ... */ });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  // ...
} catch (err) {
  setError('搜索失败,请稍后重试');
  console.error(err);
}
```

### 3. 添加缓存指示器

```typescript
// 从reply中提取来源信息
const sourceMatch = reply.match(/\(来源:\s*(.+?),\s*(.+?)\)/);
if (sourceMatch) {
  const [_, searchEngine, cacheStatus] = sourceMatch;
  // 显示来源标签
}
```

---

## 🎯 Imagine Cup演示建议

### 演示脚本:

1. **打开网页** → "这是我们的校园AI助手Alice"
2. **点击Search模式** → "支持智能搜索功能"
3. **输入'人工智能'** → "第一次搜索,约3秒"
4. **再次搜索'人工智能'** → "缓存命中,仅需50毫秒!"
5. **展示来源标签** → "绿色闪电图标表示从缓存加载,零成本"
6. **切换到Class模式** → "还支持课表管理等功能"

### UI亮点:

- ✨ Rive动画Alice形象(可点击戳一戳)
- 🎨 暗黑/亮色主题切换
- 🚀 流式响应打字机效果
- 📊 实时搜索来源指示器
- 💰 缓存命中率展示

---

## 🐛 常见问题

### Q1: CORS错误
**解决**: 在Azure Function添加CORS配置允许`http://localhost:3000`

### Q2: 超时
**解决**: 增加fetch timeout,或使用流式响应

### Q3: 结果格式错乱
**解决**: 检查正则表达式是否匹配后端返回格式

---

## 📦 依赖清单

已安装:
- ✅ Next.js 16
- ✅ React 19
- ✅ Vercel AI SDK
- ✅ @rive-app/react-canvas
- ✅ lucide-react (图标库)
- ✅ Tailwind CSS 4

需要添加(可选):
```bash
npm install react-markdown
npm install @tanstack/react-query  # 用于数据缓存
```

---

**下一步**: 执行步骤3修改 `app/api/chat/route.ts`
