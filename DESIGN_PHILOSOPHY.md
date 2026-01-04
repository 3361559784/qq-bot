\# Design Philosophy: From “Making Her More Human” to “Making the System Less Harmful”

> **“I no longer ask whether AI can be more like a human; I ask whether we can make the system harm people less.”**

---

## This is a record of my personal journey

If you only want to deploy the QQ bot, go back to [README.md](README.md).  
If you want to understand why this system evolved into its current form, keep reading.

---

## Three phases of my thinking

### Phase 1: Treating AI as an object of emotional projection (Nov 2024)

Early on, I tried to build something like Neuro-sama:
a persistent persona, emotional reactions, playful responses, proactive interaction.

At that time, I wasn’t focused on “system reliability”, but on:
- whether it felt human
- whether it felt warm
- whether it could be liked

This assumes something implicitly:
**that AI can carry emotional expectations.**

Later I realized: that assumption itself is a source of risk.

### Phase 2: “Reasonable output” is not the same as a “responsible system” (Dec 2024)

In real usage, a fundamental issue became obvious:

LLMs are optimized to produce answers that *sound* reasonable,
but campus scenarios require behavior that is **accountable, verifiable, and able to refuse**.

Typical risks include:
- making up schedules when data is missing
- guessing user intent when context is unclear
- using fluent language to hide uncertainty

This made me realize:
**“Understanding” is not language fluency; it is the judgment of responsibility boundaries.**

So I introduced layered constraints:
- separating Evidence vs. Claim
- role separation across multiple LLM layers
- decoupling channels from persona
- explicit human confirmation points

### Phase 3: Accepting the non-replaceable boundary of AI (Jan 2025)

When I seriously asked “If I keep pushing the ‘persona’ path, what will this system become?”
the answer was clear:

No matter how human it appears,
it is still a system driven by prompts and probability distributions.

Persona continuity is not understanding,
and emotional reactions are not responsibility.

I eventually settled on this principle:
**AI can never—and should never—replace a human’s position.**

From that moment, the project goal shifted:
not “more human”, but **no overreach, no misleading, and explainable refusal**.

---

## The bottom lines I set for this system

While designing Alice, I learned that without deliberate limits,
LLMs are easily used as “objects of emotional projection”.

So I explicitly prohibit these goals:

- seeking to be needed
- encouraging dependency
- carrying emotional projection

The engineering goals are only three:

- don’t mislead
- don’t overreach
- don’t pretend to “understand everything about humans”

---

## Three key insights

### 1) Why I started building “Explainable Refusal”

Early versions simply refused when a rule was triggered.
That was safe, but it failed the user experience:

- users don’t know what crossed the line
- users can’t tell whether the conversation can continue
- refusal becomes a hard “disconnect point”

So I broke refusal into three steps:
find the reason → explain it in human terms → provide a viable alternative path.

The goal is not to “solve everything”,
but to **not abandon the user at the system level**.

### 2) Why “clarify first” matters more than “search first”

When uncertain, an LLM tends to take the easiest route: search or answer immediately.

But many failures are not knowledge errors — they are context errors.

So when the input is ambiguous, I want the system to pause and confirm:
Is this conceptual discussion, emotional expression, or a concrete question?

One clarification
is more reliable than ten searches.

### 3) Why I need a “don’t overstate” mode

In persona mode, systems can become overconfident;
in professional mode, they can become cold.

What I found dangerous is not “being wrong”,
but **answering too fast without thinking**.

So I introduced an in-between state:
no acting, no companionship, no rushing — just one thing:

> Confirm I understood correctly, then decide whether to continue.

---

## Practical examples: how I keep the system from “doing random things”

### Red-line awareness: if you don’t know, say you don’t know

When users ask for concrete facts (e.g., schedules),
the system first checks whether it has a clear data source.

If structured schedule data exists → answer normally.

If not → clearly state the lack of data instead of guessing:

“I don’t have your schedule data yet, so I can’t tell what classes you have tomorrow.
If you want, you can upload your schedule or provide a source first.”

I’d rather the system look “less capable”
than let it fabricate a plausible-sounding answer.

### One responsibility model: wording can vary, judgment cannot

The system uses one decision framework:

- is data sufficient?
- is the responsibility boundary crossed?
- is this an appropriate time to answer?

“Relaxed” vs “serious” only affects wording intensity, not the decision path.

Once it involves:

- factual statements
- behavioral suggestions
- time / schedules / risk

the output automatically becomes conservative, explainable, and traceable.

This is not style. It is responsibility priority.

### Capability degradation must be stated explicitly

I intentionally make the system admit its limitations:

“Before I have your personal data,
I can only offer very limited assistance.
I can’t understand your specific campus routine yet.”

This isn’t “weakness”; it prevents users from:

- overestimating the system’s capability
- over-trusting outputs
- mistaking language fluency for real understanding

The system must tell users when it is “just a generic LLM.”

---

## Paths I deliberately did not take

There are some “popular” directions I chose not to pursue (for now):

- building a fully autonomous looping agent
- making persona responsible for emotional companionship
- optimizing for human-like, roleplay-heavy conversation

Not because they are always wrong,
but because at this stage,
I cannot take responsibility for their consequences.

---

## I realized

> **“Being cute” is not a liability waiver, and “having a persona” is not a trust foundation.**

## Closing

If you build AI, don’t only ask “how to make it smarter”. Ask “who gets hurt when it isn’t.”

这不是示弱，这是**负责任**。

---

## 致谢

这个项目的演变，记录了一个开发者从：
- "我想被看见" → "我想被理解" → "我需要一个翻译器"

从：
- "想让 AI 更像人" → "想让系统少害人"

感谢所有在群里被 Alice "编造课表"坑过的同学，是你们让我意识到：

> **"可爱"不是免责金牌，"有人设"不是信任基础。**

---

## 最后

如果你也在做 AI 项目，我想对你说：

**不要问"AI 能不能更聪明"，问"AI 在不聪明时会造成什么伤害"。**

这不是悲观，这是**工程伦理**。

---

*Written by Ziheng Liu*  
*A complete record of the journey from "making her more human" to "making the system less harmful"*
