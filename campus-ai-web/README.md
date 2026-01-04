# 🎓 Campus AI Web - Alice智能校园助手

基于Next.js的校园AI助手前端,集成智能搜索、课表管理、语音交互等功能。

<div align="center">

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-blue?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org)
[![Tailwind](https://img.shields.io/badge/Tailwind-4-38bdf8?logo=tailwind-css)](https://tailwindcss.com)

</div>

---

## ✨ 功能特性

### 🔍 智能搜索
- ✅ 5层智能路由 (缓存→本地→DuckDuckGo→SerpAPI→LLM)
- ✅ 90%+免费搜索 (零API成本)
- ✅ 缓存命中<50ms极速响应
- ✅ 来源可视化标签

### 🎨 交互体验
- ✅ Rive动画Alice形象
- ✅ 暗黑/亮色主题切换
- ✅ 响应式设计(移动端适配)
- ✅ 流式响应打字机效果

### 📚 多模式支持
| 模式 | 功能 | 状态 |
|------|------|------|
| 🔍 Search | 智能搜索 | ✅ 已完成 |
| 💬 Ask | 普通对话 | ✅ 已完成 |
| 📋 Plan | 学习计划 | 🚧 开发中 |
| 📚 Class | 课表管理 | 🚧 开发中 |

---

## 🚀 快速启动

### 前置条件
- Node.js 18+
- Azure Function后端已启动 (`func start`)

### 安装依赖
```bash
npm install
```

### 配置环境变量
复制 `.env.local` 并填写:
```bash
NEXT_PUBLIC_AZURE_FUNCTION_URL=http://localhost:7071/api/schoolBot
```

### 启动开发服务器
```bash
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000) 查看效果。

---

## 📖 完整文档

| 文档 | 说明 |
|------|------|
| [QUICK_START.md](QUICK_START.md) | 5分钟快速启动指南 |
| [FRONTEND_INTEGRATION_GUIDE.md](FRONTEND_INTEGRATION_GUIDE.md) | 前端集成详细指南 |
| [../docs/SEARCH_DEPLOYMENT_GUIDE.md](../docs/SEARCH_DEPLOYMENT_GUIDE.md) | Azure部署指南 |

---

## 🏗️ 项目结构

```
campus-ai-web/
├── app/
│   ├── page.tsx              # 主页面(含模式切换)
│   ├── layout.tsx            # 根布局
│   ├── globals.css           # 全局样式
│   └── api/
│       └── chat/
│           └── route.ts      # API路由(对接后端)
├── components/
│   ├── AliceAvatar.tsx       # Rive动画组件
│   └── SearchResults.tsx    # 搜索结果展示组件
├── public/
│   └── alice.riv            # Rive动画文件
├── .env.local               # 环境变量(需创建)
├── QUICK_START.md           # 快速启动指南
└── README.md                # 本文档
```

---

## 🧪 测试搜索功能

### 1. 启动后端
```bash
# 在项目根目录
cd /Users/liuziheng/qq-bot-aris-clean
func start
```

### 2. 启动前端
```bash
# 在campus-ai-web目录
npm run dev
```

### 3. 测试用例
访问 `http://localhost:3000`:
1. 点击侧边栏 **Search** 图标🔍
2. 输入 `人工智能`
3. 查看美化的搜索结果卡片
4. **再次搜索同一词汇** → 缓存命中,<1秒返回

---

## 🎨 技术栈

- **框架**: Next.js 16 (App Router)
- **UI库**: React 19
- **样式**: Tailwind CSS 4
- **动画**: Rive (@rive-app/react-canvas)
- **图标**: Lucide React
- **AI集成**: Vercel AI SDK
- **后端**: Azure Functions + Cosmos DB

---

## 📊 性能指标

| 指标 | 数值 |
|------|------|
| 首屏加载 | <2s |
| 缓存命中响应 | <50ms |
| DuckDuckGo搜索 | 3-7s |
| 缓存命中率 | 66.7%+ |
| 免费搜索占比 | 90%+ |

---

## 🐛 故障排查

### ❌ "fetch failed"
**解决**: 确保后端已启动
```bash
curl http://localhost:7071/api/schoolBot
```

### ❌ CORS错误
**解决**: 在 `host.json` 添加CORS配置:
```json
{
  "extensions": {
    "http": {
      "cors": {
        "allowedOrigins": ["http://localhost:3000"]
      }
    }
  }
}
```

### ❌ 环境变量未生效
**解决**: 重启开发服务器
```bash
# Ctrl+C 停止
npm run dev  # 重新启动
```

---

## 🎓 Imagine Cup演示

### 演示脚本 (2分钟)
1. **开场**: "Alice智能校园助手"
2. **搜索演示**: 输入查询,展示结果
3. **缓存亮点**: 第二次搜索<1秒
4. **成本优化**: 展示免费搜索占比
5. **交互体验**: Alice动画+模式切换

### 准备工作
```bash
# 填充演示数据
cd /Users/liuziheng/qq-bot-aris-clean
node tools/seed-search-data.js

# 启动服务
func start  # 终端1
npm run dev # 终端2
```

---

## 📝 开发脚本

```bash
# 开发模式
npm run dev

# 构建生产版本
npm run build

# 启动生产服务器
npm start

# 代码检查
npm run lint
```

---

## 🤝 贡献

欢迎提交Issue和Pull Request!

---

## 📄 许可证

Apache License 2.0 (Apache-2.0)。见仓库根目录的 `LICENSE` 与 `NOTICE`。

---

**🚀 开始使用**: 阅读 [QUICK_START.md](QUICK_START.md)

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
