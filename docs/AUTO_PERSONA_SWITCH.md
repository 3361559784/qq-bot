> **Languages**: [English README](../README.md) | [中文](../README.zh.md) | [日本語](../README.jp.md) | [Русский](../README.ru.md)

# 🔄 自动 Persona 切换实现文档

## 📋 功能概述

基于双模型架构，实现了**智能 Persona 自动切换**功能：
- 第一层模型：理解上下文 → 意图分类（`intentResult.tool`）
- 第二层模型：根据意图自动选择合适的风格（Pro 专业 vs Alice 活力）

### 核心规则

| 任务类型 | 触发条件 | 自动 Persona | 风格特征 |
|---------|---------|-------------|---------|
| **决策/规划** | `tool=plan` 或 `tool=schedule` | `professional` | 严谨、条目化、时间精确、无情绪标签 |
| **闲聊/引导** | `tool=chat` 或 `tool=identity` | `alice` | 活力、可爱、情感连接、有游戏术语 |
| **用户显式指定** | 前端传入 `persona` 参数 | 用户指定值 | 优先级最高，覆盖自动推荐 |

---

## 🔧 技术实现

### 代码位置
**文件**: `src/functions/schoolBot.js`

### 实现步骤

#### 1. 意图检测后自动推荐 Persona（Line ~5690）
```javascript
// 🆕 基于意图自动推荐 Persona（双模型自动切换核心逻辑）
// 决策/规划类任务 → 自动使用 Professional 模式（严谨、条目化、时间精确）
// 闲聊/引导类任务 → 自动使用 Alice 模式（活力、可爱、情感连接）
let autoRecommendedPersona = null;
if (intentResult?.tool) {
    const decisionTools = ['plan', 'schedule']; // 决策/规划工具
    const chatTools = ['chat', 'identity'];      // 闲聊/身份类工具
    
    if (decisionTools.includes(intentResult.tool)) {
        autoRecommendedPersona = 'professional';
        context?.log?.(`[自动切换] tool=${intentResult.tool} → Professional 模式`);
    } else if (chatTools.includes(intentResult.tool)) {
        autoRecommendedPersona = 'alice';
        context?.log?.(`[自动切换] tool=${intentResult.tool} → Alice 模式`);
    }
}

// 也可基于 inferredMode 做补充推荐（关键词驱动的模式推断）
if (!autoRecommendedPersona && (inferredMode === 'Plan' || inferredMode === 'Class')) {
    autoRecommendedPersona = 'professional';
    context?.log?.(`[自动切换] inferredMode=${inferredMode} → Professional 模式`);
}
```

#### 2. 优先级逻辑（Line ~5978）
```javascript
// 🔥 优先级：用户显式指定 > 自动推荐 > 默认（Alice）
const userExplicitPersona = body?.persona; // 用户显式指定（如果有）
const effectivePersona = userExplicitPersona || autoRecommendedPersona || 'alice';
const isUserProfessionalMode = effectivePersona === 'professional';

context?.log?.(`[Persona选择] 用户指定=${userExplicitPersona || '无'}, 自动推荐=${autoRecommendedPersona || '无'}, 最终=${effectivePersona}`);

// 身份/定位问题：强制使用专业提示词，避免 Chat 人设把回答带偏
if (isCopilotMode || isUserProfessionalMode || isIdentityMode) {
    basePrompt = COPILOT_PROMPT_ZH;
}
```

---

## 🧪 验证测试

### 测试脚本
**文件**: `test-auto-persona-switch.sh`

```bash
./test-auto-persona-switch.sh
```

### 测试场景与结果

#### 场景1：决策判断类问题（无 persona 参数）
**输入**:
```json
{
  "raw_message": "我明天有4小时连续空档，合适用来复习线性代数吗？"
}
```

**预期**: Professional 模式（无情绪标签、无 Sensei、直接结论）

**实际输出**:
```
目前没有检测到您的课表数据，因此无法判断明天是否有4小时连续空档以及其是否适合复习线性代数。请先导入课表，之后我可以为您做精确的时间冲突与空档判断。
```

✅ **通过** - 使用 Professional 模式

---

#### 场景2：计划拆解类问题（无 persona 参数）
**输入**:
```json
{
  "raw_message": "帮我把大作业拆解成具体的学习计划"
}
```

**预期**: Professional 模式

**实际输出**:
```
目前没有检测到您的课表数据。请先导入课表，之后我可以帮您结合课程安排拆解学习计划。
```

✅ **通过** - 使用 Professional 模式

---

#### 场景3：闲聊打招呼（无 persona 参数）
**输入**:
```json
{
  "raw_message": "你好呀爱丽丝！"
}
```

**预期**: Alice 模式（有情绪标签、Sensei、游戏术语）

**实际输出**:
```
[happy] Sensei，欢迎回来！爱丽丝已经存档完毕，准备随时接收新的任务了。(举起拖把) 邦邦咔邦！(✨ω✨)
```

✅ **通过** - 使用 Alice 模式

---

#### 场景4：闲聊问题 + 显式指定 professional
**输入**:
```json
{
  "raw_message": "你好呀！",
  "persona": "professional"
}
```

**预期**: Professional 模式（用户指定优先级最高）

**实际输出**:
```
您好！当前没有导入您的课表数据。如需查询课程信息或安排，请先导入课表。
```

✅ **通过** - 使用 Professional 模式（尊重用户显式指定）

---

#### 场景5：MVP核心场景 - 时间冲突判断
**输入**:
```json
{
  "raw_message": "我现在开始复习3小时的《数据结构》会不会被打断？"
}
```

**预期**: Professional 模式（决策类关键词）

**实际输出**:
```
目前没有检测到您的课表数据。请先导入课表，之后我可以帮您判断复习时间是否合适及是否会被课程打断。
```

✅ **通过** - 使用 Professional 模式

---

## 🎯 MVP 价值

### 问题解决
1. **手动切换效率低**：之前需要前端每次传入 `persona` 参数
2. **Demo 演示不稳定**：决策类任务可能误用 Alice 风格，影响专业性
3. **用户体验不连贯**：闲聊和决策混合时风格切换不自然

### 改进效果
1. ✅ **智能自动化**：后端根据意图自动选择最合适的风格
2. ✅ **MVP 演示稳定**：决策/规划任务必定使用专业格式
3. ✅ **用户体验提升**：闲聊时保持活力，决策时专业严谨
4. ✅ **灵活可控**：前端仍可显式指定 persona 以覆盖自动推荐

---

## 📊 关键词触发列表

### 决策/规划类关键词（触发 Professional 模式）
```javascript
// 决策判断
['合不合适', '合适吗', '可以吗', '行不行', '能不能', '适合吗', 
 '会不会被打断', '会不会冲突', '有没有时间', '来得及吗', '赶得上吗']

// 计划拆解
['计划', '规划', '安排', '拆解', '拆任务', '任务拆解', 
 '学习计划', '复习计划', '时间表', '待办', 'todo']

// 课表查询
['课表', '课程表', '有课', '下一节课', '下节课', '接下来有什么课', 
 '明天有课吗', '今天有课吗', '下周课表', '本周课表', '这周课表']
```

### 闲聊/引导类关键词（触发 Alice 模式）
```javascript
// 打招呼
['你好', 'hello', 'hi', '早上好', '晚上好']

// 身份询问
['你是谁', '你叫什么', '介绍一下', '你是什么']

// 情感互动
['爱丽丝', '女仆', '陪聊', '聊天']
```

---

## 🔄 与前端集成

### 前端无需改动（向后兼容）
- 前端继续传入 `persona` 参数 → **优先级最高**，覆盖自动推荐
- 前端不传 `persona` 参数 → **后端自动推荐**，智能切换

### 建议前端使用方式

#### 方式1：完全依赖后端自动切换（推荐）
```javascript
const response = await fetch('/api/schoolBot', {
  method: 'POST',
  body: JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    raw_message: userInput,
    user_id: userId
    // 不传 persona 参数，让后端自动判断
  })
});
```

#### 方式2：用户显式切换（保留开关）
```javascript
const response = await fetch('/api/schoolBot', {
  method: 'POST',
  body: JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    raw_message: userInput,
    user_id: userId,
    persona: userPreference // 'alice' 或 'professional'
  })
});
```

#### 方式3：特定场景强制 Pro（MVP Demo）
```javascript
// MVP Demo 演示决策类功能时，可以显式指定确保万无一失
const response = await fetch('/api/schoolBot', {
  method: 'POST',
  body: JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    raw_message: "我明天有4小时空档，合适复习吗？",
    user_id: userId,
    persona: 'professional' // 强制 Pro 模式（可选）
  })
});
```

---

## 🎉 测试结果总结

| 测试场景 | 输入 persona | 自动推荐 | 最终使用 | 结果 |
|---------|------------|---------|---------|------|
| 决策判断类 | 无 | professional | professional | ✅ 通过 |
| 计划拆解类 | 无 | professional | professional | ✅ 通过 |
| 闲聊打招呼 | 无 | alice | alice | ✅ 通过 |
| 闲聊 + 显式 Pro | professional | alice | **professional** | ✅ 通过（用户指定优先） |
| MVP 冲突判断 | 无 | professional | professional | ✅ 通过 |

**所有测试 100% 通过！** 🎯

---

## 📝 开发日志

**开发时间**: 2024-01-XX  
**开发者**: GitHub Copilot  
**相关 Issue**: MVP 反馈 - 双模型自动切换需求  

**变更记录**:
1. 在 `schoolBot.js` 第一层意图检测后增加 `autoRecommendedPersona` 逻辑
2. 修改 Persona 选择优先级：用户显式 > 自动推荐 > 默认
3. 增加日志输出：`[自动切换]` 和 `[Persona选择]`
4. 创建综合测试脚本 `test-auto-persona-switch.sh`
5. 所有测试场景验证通过

---

## 🚀 后续优化建议

1. **扩展意图分类**：支持更多 tool 类型的 persona 映射（如 `weather` → `alice`，`wiki` → `professional`）
2. **混合模式**：对于"决策+情感"混合问题，可以引入 "semi-professional" 模式（专业但保留少量活力元素）
3. **前端 UI 优化**：在 UI 上显示当前 persona 状态（自动 vs 手动），让用户了解系统行为
4. **A/B 测试**：收集用户反馈，优化自动切换的触发阈值和关键词列表
5. **Prompt 微调**：针对自动切换场景，微调 Professional 和 Alice 的 prompt 边界，确保差异化更明显

---

## 📞 联系与反馈

如有问题或建议，请联系开发团队或在项目 Issue 中提出。
