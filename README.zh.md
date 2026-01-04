# Alice / Campus Copilot

一个以安全为核心的校园 AI 助手，旨在**避免幻觉、误导和责任漂移**。

> 💡 如果你想了解**为何这个项目会存在**及其设计历程，请阅读 [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md)。  
> 🏗️ 想看技术架构与系统实现，请查看 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 这个项目解决了什么问题？

大多数校园聊天机器人优化的是：
- 自然对话
- 人设连续性
- 互动指标

而这个项目优化的是：
- ❗ **不编造课表数据**（不虚构课程时间）
- ❗ **不归因错误**（责任归属清晰）
- ❗ **知道何时拒绝**（并能解释原因）

---

## 核心设计原则

| 原则 | 含义 |
|------|------|
| **证据优先于流畅** | 展示数据来源，而非仅靠顺滑语言 |
| **拒绝必须可解释** | 每次拒绝都附带原因 |
| **判断由人类负责** | AI 辅助，决策留给人 |
| **默认不制造情感依赖** | 陪伴 ≠ 核心责任 |

---

## 关键特性

✅ **多层安全路由**  
- 确定性规则 + LLM 安全检测 + 意图分类

✅ **解释型拒绝层**  
- 每次拒绝都包含：原因标签、可替代帮助、下一步指引

✅ **先澄清再搜索**  
- 模糊输入？先问清楚，再决定是否搜索

✅ **双交互模式**  
- QQ：Alice 形象（活泼、符合校园文化）  
- Web：Copilot 模式（专业、简洁）

✅ **关键行为需人工确认**  
- 不允许自动循环，自主操作需要人工批准

---

## 何时**不**该用这个项目

❌ 如果你想要一个情绪化陪伴 AI  
❌ 如果你需要自循环的自治 Agent  
❌ 如果你重视“像人一样”胜过正确性  
❌ 如果你想要全天候、零护栏的自由聊天

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Azure Functions（Node.js 20+） |
| 前端 | Next.js 14 + TypeScript |
| 数据库 | Azure Cosmos DB（NoSQL） |
| 搜索 | Azure AI Search + DuckDuckGo |
| 视觉 | Azure Computer Vision + Llama Vision |
| 监控 | Application Insights |

---

## 快速开始

### 前置条件
- Node.js 20+
- Azure Functions Core Tools 4.x
- Azure 订阅（用于 Cosmos DB、Functions、AI Search）

### 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp local.settings.json.example local.settings.json
# 编辑 local.settings.json，填写你的 API Key

# 3. 启动后端（Azure Functions）
func host start

# 4. 启动前端（可选 Web UI）
cd campus-ai-web && npm run dev
```

### 部署到 Azure

```bash
# 方案①：使用部署脚本
./deploy-functions.sh

# 方案②：推 main 分支（触发 GitHub Actions）
git push origin main
```

---

## 项目结构

```
qq-bot-aris-clean/
├── src/
│   ├── functions/
│   │   ├── schoolBot.js        # 主逻辑（7000+ 行演化史）
│   │   └── dailyClassReminder.js
│   └── common/
│       └── safety.js           # 确定性安全模块
├── services/                   # 模块化服务
│   ├── hybridSearch.js
│   ├── scheduleService.js
│   └── visionService.js
├── campus-ai-web/              # Next.js 前端
├── docs/                       # 设计演变文档
└── .github/workflows/          # CI/CD
```

---

## 文档目录

| 文档 | 作用 |
|------|------|
| [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) | 项目存在原因、设计心路与核心信念 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 技术架构、分层安全与实现细节 |
| [docs/P0-INTEGRATION-GUIDE.md](docs/P0-INTEGRATION-GUIDE.md) | 生产部署集成指南 |

---

## 贡献说明

这个项目既是**学习笔记**也是**责任实验**。欢迎贡献，但请先阅读 [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md)，理解核心原则。

---

## 许可

MIT

---

## 鸣谢

感谢曾被 Alice“编造课表”误导的同学们，是你们让我认识到：**“可爱”不是免责金牌。**

也感谢所有构建 AI 系统的人：别只问“怎么让它更聪明”，而要问**“它不聪明时会造成什么伤害”。**

---

*由刘梓恒创作*
