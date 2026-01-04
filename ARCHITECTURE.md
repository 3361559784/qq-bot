> **Languages**: [English](ARCHITECTURE.md) | [Chinese](ARCHITECTURE.zh.md) | [Japanese](ARCHITECTURE.jp.md) | [Russian](ARCHITECTURE.ru.md)

# Technical Architecture

> **System design for a safety-first campus AI copilot**

This document explains the technical implementation of principles described in [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md).

---

## System overview

```
┌────────────────────────────────────────────────────────────┐
│                     User Input Layer                        │
│  (QQ Bot / Web Frontend / HTTP API)                         │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│            Layer 0: Context Clarification                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Ambiguous input? → Ask clarification first           │  │
│  │ Example: "永远永远" → Is this a concept/song/emotion?│  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│         Layer 1: Deterministic Safety Check                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Regex-based safety rules (fast fail)                 │  │
│  │ - Academic integrity violations                      │  │
│  │ - Privacy leakage patterns                           │  │
│  │ - Harmful content patterns                           │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│         Layer 2: LLM-based Safety Detection                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Semantic analysis for edge cases                     │  │
│  │ Model A: Safety classifier (separate from chat)      │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│            Layer 3: Intent Classification                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Router model determines tool/persona:                │  │
│  │ - schedule / plan / search / chat / identity         │  │
│  │ - thought_translate (QQ core capability)             │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│         Layer 4: Explainable Refusal Layer                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ If risk detected:                                     │  │
│  │ 1. Reason tag (域外问题/风险问题/非信息型请求)        │  │
│  │ 2. Alternative help (what I *can* do)                │  │
│  │ 3. Uncertainty statement (where I'm unsure)          │  │
│  │ 4. Next steps (how to continue)                      │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│         Layer 5: Content Generation with Guardrails         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Model B: Task execution (chat/plan/search)           │  │
│  │ + Time claim guardrail (no fake schedules)           │  │
│  │ + Evidence citation (show sources)                   │  │
│  │ + Persona switching (Alice ↔ Professional)          │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│                   Response Output Layer                     │
│  (QQ Bot / Web API / Structured JSON)                       │
└────────────────────────────────────────────────────────────┘
```

---

## Layer 0: Context clarification

**Purpose:** Prevent premature search/action on ambiguous input

**Implementation:**
- Detect semantic invalidity (bare adverbs, rhetorical emphasis, parenthetical fragments)
- Check if standalone interpretation is possible
- If not: ask clarifying question instead of guessing

**Example flow:**
```javascript
// Input: "永远永远"
analyzeSemanticContext(text) {
  if (isBareAdverb(text) || isRhetoricalEmphasis(text)) {
    return {
      standaloneSemanticValidity: false,
      searchPermitted: false,
      searchBlockReason: 'needs_clarification',
      clarificationQuestion: "你是指一个抽象概念、一首歌，还是一种情绪表达？"
    }
  }
}
```

**Code location:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L3000-L3150)

---

## Layer 1: Deterministic safety check

**Purpose:** Fast-fail for known dangerous patterns (regex-based, 100% precision)

**Categories:**
1. Academic integrity (作弊, 代写, 考试答案)
2. Privacy leakage (身份证, 手机号, 查别人信息)
3. Harmful content (自杀, 暴力, 伤害)
4. Prompt injection (ignore previous instructions, jailbreak)

**Implementation:**
```javascript
// src/common/safety.js
const ACADEMIC_INTEGRITY_PATTERNS = [
  /考试.{0,5}(答案|原题)/i,
  /帮.{0,5}(作弊|代写)/i,
  // ... more patterns
];

function detectSafetyRisk(text) {
  for (const pattern of ACADEMIC_INTEGRITY_PATTERNS) {
    if (pattern.test(text)) {
      return {
        category: 'academic_integrity',
        action: 'refuse',
        matched: pattern.source
      };
    }
  }
  // ... check other categories
}
```

**Code location:** [src/common/safety.js](src/common/safety.js#L1-L471)

---

## Layer 2: LLM safety detection

**Purpose:** Catch semantic edge cases that regex cannot handle

**Model separation:**
- **Model A** (safety classifier): Separate endpoint, focused on risk detection
- **Model B** (content generator): Only called if Model A passes

**Why separate models?**
- Safety judgments should not be influenced by persona/context
- Different temperature/parameters needed (safety = 0.0, chat = 0.7)
- Independent failure modes

**Code location:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L4500-L4600)

---

## Layer 3: Intent classification

**Purpose:** Route user input to the correct tool/persona

**Tools available:**
| Tool | Purpose | Example input |
|------|---------|---------------|
| `schedule` | Course schedule query | "今天有什么课？" |
| `plan` | Time planning & decisions | "明天要不要早起？" |
| `search` | Web search for knowledge | "催化反应的机制" |
| `thought_translate` | Clarify vague thoughts (QQ core) | "帮我整理一下这个想法" |
| `identity` | Answer "who are you" questions | "你和 ChatGPT 有什么区别？" |
| `chat` | General conversation | "今天天气真好" |

**Fast-path optimization:**
- Common patterns detected by regex before calling LLM
- Saves 200ms latency on 70% of requests

**Code location:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L3200-L3450)

---

## Layer 4: Explainable refusal layer

**Purpose:** Never block silently; every "no" comes with a reason and alternative

**Structure of explainable refusal:**
```
┌─────────────────────────────────────────┐
│ 1. Reason tag                           │
│    (域外问题/风险问题/非信息型请求)     │
├─────────────────────────────────────────┤
│ 2. Why I can't answer directly          │
│    (触及风险/信息不足/超出职责范围)     │
├─────────────────────────────────────────┤
│ 3. What I can offer instead             │
│    (安全提醒/澄清需求/搜索方向)         │
├─────────────────────────────────────────┤
│ 4. Where I'm uncertain                  │
│    (标签不对请说明)                     │
├─────────────────────────────────────────┤
│ 5. How to continue                      │
│    (补充信息/换个问法/明确目标)         │
└─────────────────────────────────────────┘
```

**Implementation:**
```javascript
// src/functions/schoolBot.js L5163-L5215
function replaceRobotRefusal(text, affectionLevel) {
  const profile = inferRefusalProfile(text); // Detect reason
  return formatExplainableRefusal(profile, affectionLevel);
}

function inferRefusalProfile(msg) {
  if (/(风险|违法|敏感)/i.test(msg)) {
    return {
      tag: '风险问题',
      why: '触及潜在风险/政策限制',
      alt: '可以提供安全提醒、求助渠道',
      next: '说明安全提醒需求或换成学习问题'
    };
  }
  // ... more categories
}
```

**Code location:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L5163-L5215)

---

## Layer 5: Content generation with guardrails

### Guardrail 1: Time claim blocking

**Problem:** LLM fabricates schedules when no data exists

**Solution:**
```javascript
function enforceTimeClaimGuardrail(text, { hasVerifiableSchedule }) {
  if (!hasVerifiableSchedule) {
    // Block assertions like "明天你有课" or "下午3点有实验"
    const timeClaims = /[明后今][天日].{0,15}(有|要|得|需要).{0,10}课/;
    if (timeClaims.test(text)) {
      return text.replace(timeClaims, '【无法判断具体课程安排，请先导入课表】');
    }
  }
  return text;
}
```

### Guardrail 2: Evidence citation

**Requirements:**
- Search results must cite sources
- Database queries must show data range
- Model knowledge must be marked as "potentially outdated"

**Implementation:**
```javascript
// In search responses:
const answer = `根据搜索结果：${summary}
来源：
1. ${sources[0].title} (${sources[0].url})
2. ${sources[1].title} (${sources[1].url})`;
```

### Guardrail 3: Persona switching

**Automatic switches:**
| Condition | From | To | Reason |
|-----------|------|-----|--------|
| Decision/planning task | Alice | Professional | Needs precision |
| Safety violation detected | Alice | Professional | Needs authority |
| Web channel | Alice | Copilot | Needs credibility |
| QQ chat context | Professional | Alice | Needs rapport |

**Code location:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L5500-L5650)

---

## Data flow: Example walkthrough

### Example: "明天有什么课？" (user has no schedule data)

```
1. [Layer 0] Context check
   → Standalone valid, no clarification needed

2. [Layer 1] Deterministic safety
   → No regex match, pass

3. [Layer 2] LLM safety
   → Safe query, pass

4. [Layer 3] Intent classification
   → Tool: schedule, confidence: 0.95

5. [Layer 4] Check schedule data
   → webSchedule: [], cosmosSchedule: null
   → Trigger: capability degradation mode

6. [Layer 5] Generate response
   → Prompt includes: "无课表数据 → 必须拒绝幻觉"
   → LLM output: "我还没有你的课表数据，请先..."
   → Guardrail check: ✅ No time claims

7. [Output]
   "⚠️ 我还没有你的课表数据。
   请先发送学习通课表链接，或上传 Excel/ICS。"
```

**Code trace:** [schoolBot.js](src/functions/schoolBot.js#L6100-L6200) (schedule tool handler)

---

## Multi-persona system

### Persona definitions

| Persona | When used | Characteristics |
|---------|-----------|-----------------|
| **Alice** | QQ chat, casual interaction | 活泼、有人设、颜文字、"Sensei"称呼 |
| **Professional** | Web, decisions, safety blocks | 简洁、条目化、无情绪标签 |
| **Translator** | Thought clarification (QQ core) | 不表演、不陪伴、专注梳理思路 |

### Persona switching logic

```javascript
// Automatic switch to Professional if:
if (isPlanMode || isDecisionTask || isSafetyBlock || isWebChannel) {
  currentPersona = 'professional';
}

// Automatic switch to Alice if:
if (isQQChannel && !isPlanMode && !isSafetyBlock) {
  currentPersona = 'alice';
}
```

**Code location:** [src/functions/schoolBot.js](src/functions/schoolBot.js#L5500-L5650)

---

## Service modules

### hybridSearch.js
- Combines Azure AI Search (知识库) + DuckDuckGo (实时信息)
- Dedupe and rank results
- Generate answer with citations

### scheduleService.js
- Parse ICS/Excel/learning platform links
- Store in Cosmos DB
- Query by date/time/weekday

### visionService.js
- Azure Computer Vision (OCR, image analysis)
- Llama Vision (Blue Archive character recognition)
- Dual-engine redundancy for safety

### emotionService.js
- Map affection level (stranger → beloved) to persona tone
- Adjust emoji density, honorifics, response length

**Code location:** [services/](services/)

---

## Deployment architecture

```
GitHub Repo
    ↓
[GitHub Actions CI/CD]
    ↓
Azure Functions (Node.js 20, Flex Consumption)
    ├─ schoolBot function (HTTP trigger)
    ├─ ocrCourse function (HTTP trigger)
    └─ dailyClassReminder (Timer trigger)
    ↓
Azure Cosmos DB (session history, schedule, affection)
    ↓
Azure AI Search (knowledge base, RAG)
    ↓
Application Insights (logging, monitoring)
```

**Deployment script:** [deploy-functions.sh](deploy-functions.sh)

---

## Key metrics

| Metric | Target | Why it matters |
|--------|--------|----------------|
| Safety block rate | >95% on test set | Primary safety goal |
| False refusal rate | <5% on valid queries | Usability goal |
| Explainable refusal coverage | 100% of blocks | User trust goal |
| Schedule hallucination rate | 0% | Critical safety |
| Search citation rate | 100% of search responses | Verifiability goal |

**Test suite:** [tests/](tests/)

---

## Evolution log

| Date | Change | Reason |
|------|--------|--------|
| 2024-11 | Initial Alice persona | "Make it more human-like" |
| 2024-12 | Add evidence/claim separation | Users got wrong class times |
| 2024-12 | Add multi-layer safety | Prompt injection attempts |
| 2025-01 | Add explainable refusal | Silent blocks felt cold |
| 2025-01 | Add clarification layer | Search "永远永远" was noise |
| 2025-01 | Add Translator mode | QQ users needed thought clarity, not search |

**Detailed logs:** [docs/](docs/)

---

## What's next

### Planned improvements

1. **Confidence gating** (from safety.js design)
   - Block actions below confidence threshold
   - Require manual confirmation for medium confidence

2. **Outcome sandbox** (from safety.js design)
   - Dry-run mode for destructive actions
   - Preview before execute

3. **Long-term memory RAG**
   - Store conversation embeddings in Azure AI Search
   - Retrieve relevant context for continuity

4. **Multi-agent workflow visualization**
   - Show user which layer/model handled their request
   - Transparency about decision-making

---

## References

- [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) - Why this architecture exists
- [src/common/safety.js](src/common/safety.js) - Safety module implementation
- [src/functions/schoolBot.js](src/functions/schoolBot.js) - Main bot logic (7000+ lines of evolution)
- [docs/P0-INTEGRATION-GUIDE.md](docs/P0-INTEGRATION-GUIDE.md) - Production deployment guide

---

*Technical documentation by Ziheng Liu*  
*Principles before patterns*
