# 技术架构

> **以安全为中心的校园 AI Copilot 架构说明**

本文件解释 [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) 中理念的技术实现。

---

## 系统概览

```
用户输入层（QQ / Web / HTTP API）
    ↓
第0层：语境澄清层（不确定就先问）
    ↓
第1层：确定性安全检查（正则规则）
    ↓
第2层：LLM 安全检测（语义审核）
    ↓
第3层：意图分类（工具/人格路由）
    ↓
第4层：解释型拒绝层（原因标签+替代+不确定+下一步）
    ↓
第5层：带护栏的内容生成（时间断言、证据标注、人格切换）
    ↓
响应输出层（QQ / Web / JSON）
```

---

## 第0层：语境澄清

**目标**：避免对模糊输入直接搜索/执行

**实现**：
- 检测裸副词、修辞强调、括号补充等
- 判断是否能独立理解
- 若无法：输出澄清问题并阻止后续操作

**代码位置**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L3000-L3150)

---

## 第1层：确定性安全检查

**目标**：以 100% 精度拦截已知风险

**类别**：
1. 学术诚信（作弊/代写/考试答案）
2. 隐私泄露（手机号/身份证/追查他人信息）
3. 有害内容（自杀/暴力/伤害）
4. 提示词注入（ignore instructions 等）

**实现示例**：
```javascript
const ACADEMIC_INTEGRITY_PATTERNS = [ /考试.{0,5}(答案|原题)/i, ... ];
```

**代码位置**：[src/common/safety.js](src/common/safety.js#L1-L471)

---

## 第2层：LLM 安全检测

**目标**：捕捉正则无法揭露的语义风险

**模型划分**：
- Model A（安全分类器）：独立调用，低温度
- Model B（内容生成器）：只有 Model A 通过才触发

**代码位置**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L4500-L4600)

---

## 第3层：意图分类

**目标**：把用户输入路由到正确工具/人格

**工具示例**：schedule、plan、search、thought_translate、identity、chat。

**快速路径**：常见模式用正则绕过 LLM，节省延迟。

**代码位置**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L3200-L3450)

---

## 第4层：解释型拒绝层

**目标**：拒绝时透明解释，提供替代路径

**结构**：
1. 原因标签（域外/风险/信息不足）
2. 直接拒绝理由
3. 可提供的替代
4. 不确定之处（告诉用户可纠正）
5. 下一步行动建议

**代码**：replaceRobotRefusal → inferRefusalProfile → formatExplainableRefusal。

**代码位置**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L5163-L5215)

---

## 第5层：带护栏的内容生成

### 护栏 1：时间断言 Guardrail

无课表数据时，禁止输出“明天你有课”。

### 护栏 2：证据标注

搜索回答附带来源；模型知识标明可能过时。

### 护栏 3：人格切换

| 条件 | 当前 | 切换至 | 理由 |
|------|------|--------|------|
| 决策/规划 | Alice | Professional | 需要精度 |
| 风险拦截 | Alice | Professional | 权威 |
| Web 渠道 | Alice | Copilot | 可信度 |
| QQ 闲聊 | Professional | Alice | 亲和力 |

**代码位置**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L5500-L5650)

---

## 数据流示例："明天有什么课？"

1. 第0层：语境检查 → 有效
2. 第1层：正则安全 → 通过
3. 第2层：LLM 安全 → 通过
4. 第3层：意图路由 → schedule
5. 第4层：检测到无课表 → 进入解释型拒绝
6. 第5层：生成带 Guardrail 回复
7. 输出：要求上传课表，禁止断言

**代码轨迹**：[src/functions/schoolBot.js](src/functions/schoolBot.js#L6100-L6200)

---

## 多人格系统

| 人格 | 何时使用 | 特性 |
|------|--------|------|
| Alice | QQ 聊天 | 活泼、颜文字、校园语气 |
| Professional | Web/规划 | 简洁、无情绪、条目化 |
| Translator | 思想澄清 | 不表演、不陪伴、先理解 |

**自动切换逻辑**：
```javascript
if (isPlanMode || isDecisionTask || isSafetyBlock || isWebChannel) currentPersona = 'professional';
if (isQQChannel && !isPlanMode && !isSafetyBlock) currentPersona = 'alice';
```

---

## 服务模块简介

- `hybridSearch.js`：结合 Azure AI Search 与 DuckDuckGo
- `scheduleService.js`：解析课表、存 Cosmos、按日期查询
- `visionService.js`：Azure Vision + Llama Vision 的双引擎
- `emotionService.js`：映射亲密度 -> 语气/回应长度

---

## 部署与监控

GitHub Repo → GitHub Actions CI/CD → Azure Functions（Flex Consumption） → Cosmos DB + AI Search → Application Insights

部署脚本：`deploy-functions.sh`

---

## 关键指标

| 指标 | 目标 | 重要性 |
|------|------|--------|
| Safety block rate | >95% 测试集 | 安全性第一 |
| False refusal rate | <5% | 可用性 |
| Explainable refusal coverage | 100% | 用户信任 |
| Schedule hallucination rate | 0% | 临界安全 |
| Search citation rate | 100% | 可验证性 |

---

## 演进历程

| 日期 | 变更 | 原因 |
|------|------|------|
| 2024-11 | Alice 人格 | 追求"人味" |
| 2024-12 | Evidence/Claim 分离 | 用户收到错误课表 |
| 2024-12 | 多层安全 | 提示词注入攻击 |
| 2025-01 | 解释型拒绝 | 生冷拒绝缺乏温度 |
| 2025-01 | 澄清层 | "永远永远"搜索噪音 |
| 2025-01 | Translator 模式 | QQ 用户需要思路整理 |

---

## 下一步计划

1. Confidence gating — 低置信度下阻止行为
2. Outcome sandbox — 危险操作的干跑模式
3. Long-term memory RAG — 在 AI Search 存储 embedding
4. 可视化输出 — 显示用户请求被哪一层处理

---

## 参考资源

- [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md)
- [src/common/safety.js](src/common/safety.js)
- [src/functions/schoolBot.js](src/functions/schoolBot.js)
- [docs/P0-INTEGRATION-GUIDE.md](docs/P0-INTEGRATION-GUIDE.md)

---

*技术文档编著：刘梓恒*  
*原则大于模式*
