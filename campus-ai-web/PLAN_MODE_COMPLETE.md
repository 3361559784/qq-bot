# ✅ Plan模式完整实现报告

## 📅 实现概览

已成功实现**Plan模式**（智能计划生成），这是Imagine Cup项目的核心创新点之一。

---

## 🎯 核心功能

### 1. **智能计划生成**
- 结合**用户课表** + **实时天气** + **时间信息**
- 自动生成个性化的每日计划
- AI分析课间空闲时间,提供建议

### 2. **天气联动提示**
- ☂️ 下雨提醒带伞
- 🌞 晴天提醒防晒
- 🌧️ 暴雨推荐路线调整

### 3. **美观的时间轴UI**
- 彩色时间线展示
- 课程/学习/休息分类标签
- 地点信息显示

---

## 📂 新增文件

### `/api/plan/route.ts`
```typescript
// Plan模式API端点
export async function POST(req: Request) {
  - 接收用户意图 (userIntent)
  - 调用后端 /api/schoolBot (前缀: "计划:")
  - 返回结构化计划内容
}
```

### `/components/PlanView.tsx`
```typescript
// Plan展示组件
<PlanView planContent={string}>
  - 解析计划文本 (支持时间格式: 9:00-11:00)
  - 渲染时间轴视图
  - 提取天气提示
  - 分类标签 (class/study/break/activity)
</PlanView>
```

### `/src/functions/schoolBot.js` (新增指令)
```javascript
// 指令:计划 <需求>
const planMatch = msg.match(/^(计划|plan)[:：\s]+(.+)/i);

流程:
1. 查询Cosmos DB获取用户课表
2. 调用心知天气API获取实时天气
3. 构造System Prompt (包含课表+天气)
4. 调用GPT-4生成智能计划
5. 返回结构化回复
```

---

## 🔄 修改文件

### `/app/page.tsx`
**新增状态管理:**
```typescript
const [planContent, setPlanContent] = useState<string | null>(null);
const [planLoading, setPlanLoading] = useState(false);
```

**Plan模式UI分支:**
```tsx
{currentMode === "Plan" ? (
  <PlanView planContent={planContent} />
) : (
  // 其他模式的聊天界面
)}
```

**快捷按钮:**
- 🎓 今日学习计划
- 📆 明日完整安排

---

## 🎨 Alice情绪联动

Plan模式已集成Alice情绪系统:

| 事件 | Alice情绪 | 颜文字气泡 |
|------|----------|-----------|
| 点击"生成计划" | thinking | (・ω・)? |
| 计划成功返回 | happy | (≧∇≦)/ |
| API失败 | angry | (`皿´) |

---

## 🧪 测试流程

### 前端测试
```bash
cd campus-ai-web
npm run dev
# 访问 http://localhost:3000
# 点击左侧 Plan 图标
# 点击"今日学习计划"按钮
```

### 后端测试
```bash
# 启动Azure Function
cd /Users/liuziheng/qq-bot-aris-clean
func start

# 测试"计划:"指令
curl -X POST http://localhost:7071/api/schoolBot \
  -H "Content-Type: application/json" \
  -d '{
    "post_type": "message",
    "user_id": 888888888,
    "message": "计划:明天的学习安排"
  }'
```

---

## 📊 示例输出

### 输入
```
计划:明天的学习安排
```

### 输出
```
📅 明日学习计划 (✨ω✨)

8:00-8:50 高等数学 @ 教学楼A101
9:00-9:50 大学英语 @ 文科楼302
10:00-10:50 自习时间 (建议预习下午的物理课)

12:00-13:30 午休 (明天有雨,记得带伞☂️)

14:00-15:30 大学物理 @ 实验楼204
15:30-16:00 课间休息 (推荐去图书馆看书)

🌧️ 明天有雨,建议:
- 提前10分钟出门
- 带好雨伞和防水包
- 选择有遮挡的路线
```

---

## 🔗 数据流图

```
[用户输入: "明天的计划"]
         ↓
[前端 /api/plan]
         ↓
[后端 schoolBot.js "计划:" 指令]
         ↓
    ┌────┴────┐
    │         │
[Cosmos DB] [心知天气API]
 (课表数据)   (实时天气)
    │         │
    └────┬────┘
         ↓
    [GPT-4生成计划]
         ↓
    [PlanView组件渲染]
```

---

## 🎯 核心创新点

### 1. **多维度数据融合**
- 传统日历APP只显示课表
- Plan模式结合**课表+天气+AI分析**,生成智能建议

### 2. **主动规划能力**
- 不只是"查询"课表
- 能"推荐"如何利用课间时间

### 3. **情境感知**
- 天气变化 → 自动调整出行建议
- 课程密集 → 提醒休息时间
- 长时间空闲 → 推荐学习任务

---

## 🚀 Imagine Cup演示亮点

### 演示脚本 (30秒)
```
1. [点击Plan图标]
   "这是Plan模式,Alice的核心创新功能"

2. [点击"今日学习计划"]
   "Alice会自动获取我的课表和实时天气..."

3. [展示生成的计划]
   "你看,她不仅显示课表,还分析了课间空闲时间,
    并且因为今天有雨,贴心地提醒我带伞☂️"

4. [切换到QQ机器人]
   "更神奇的是,我在网页上生成的计划,
    也可以在QQ上同步查看,数据完全打通!"
```

---

## ✅ 完成状态

| 任务 | 状态 | 备注 |
|------|------|------|
| Plan API后端 | ✅ | /api/plan/route.ts |
| PlanView组件 | ✅ | 时间轴UI完整 |
| schoolBot指令 | ✅ | "计划:" 前缀支持 |
| Alice情绪联动 | ✅ | thinking/happy/angry |
| 天气API集成 | ✅ | 复用心知天气 |
| 课表数据查询 | ✅ | Cosmos DB scheduleProfile |
| 快捷按钮 | ✅ | 今日/明日计划 |

---

## 🔜 未来优化

### Phase 2 (可选)
- [ ] 多日计划预览 (本周计划视图)
- [ ] 计划导出PDF
- [ ] 日程提醒推送 (结合QQ机器人)
- [ ] 学习时长统计
- [ ] 自定义计划模板

---

## 📝 使用说明

### 开发者
1. 确保`.env.local`配置正确:
   ```env
   NEXT_PUBLIC_AZURE_FUNCTION_URL=http://localhost:7071/api/schoolBot
   ```

2. 确保后端环境变量包含:
   ```env
   COSMOS_DB_STRING=<连接字符串>
   SENIVERSE_API_KEY=<心知天气Key>
   OPENAI_API_KEY=<OpenAI Key>
   ```

### 用户
1. 点击左侧Plan图标
2. 选择快捷按钮或输入自定义需求
3. 等待Alice生成计划
4. 查看时间轴视图

---

## 🎉 总结

Plan模式是**Alice校园AI助手**区别于传统课表APP的核心竞争力。通过AI智能分析,将"被动查询"升级为"主动规划",真正实现**个性化校园助手**的愿景。

**完成时间:** 2025年1月  
**实现者:** Claude Sonnet 4.5  
**状态:** ✅ 生产就绪
