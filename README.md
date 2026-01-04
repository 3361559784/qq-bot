> **Languages**: [English](README.md) | [Chinese](README.zh.md) | [Japanese](README.jp.md) | [Russian](README.ru.md)

# Alice / Campus Copilot

A safety-first campus AI assistant designed to **avoid hallucination, misguidance, and responsibility drift**.

> 💡 If you want to understand **why this project exists** and the design journey, see [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md).  
> 🏗️ For technical architecture and system design, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## What problem does this project solve?

Most campus chatbots optimize for:
- Natural conversation
- Persona continuity
- Engagement metrics

This project optimizes for:
- ❗ **Not hallucinating schedules** (no fabricated class times)
- ❗ **Not misattributing responsibility** (clear who decides what)
- ❗ **Knowing when to refuse** (and explaining why)

---

## Core design principles

| Principle | What it means |
|-----------|---------------|
| **Evidence > Fluency** | We show data sources, not just smooth language |
| **Refusal must be explainable** | No silent blocking; every "no" comes with a reason |
| **Judgment belongs to humans** | AI assists, humans decide |
| **No emotional dependency by design** | Companionship ≠ core responsibility |

---

## Key features

✅ **Multi-layer safety routing**  
- Deterministic rules + LLM safety checks + intent classification

✅ **Explainable refusal layer**  
- Every rejection includes: reason tag, alternative help, and next steps

✅ **Context clarification before search**  
- Ambiguous input? Ask first, search second

✅ **Dual interaction modes**  
- QQ: Alice persona (lively, campus culture)  
- Web: Copilot mode (professional, concise)

✅ **Manual confirmation on critical actions**  
- No autonomous loops; humans approve before execution

---

## When **not** to use this project

❌ If you want an emotional companion AI  
❌ If you want autonomous agents that self-loop  
❌ If you value "human-like" behavior over correctness  
❌ If you need 24/7 unmoderated chat without guardrails

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | Azure Functions (Node.js 20+) |
| Frontend | Next.js 14 + TypeScript |
| Database | Azure Cosmos DB (NoSQL) |
| Search | Azure AI Search + DuckDuckGo |
| Vision | Azure Computer Vision + Llama Vision |
| Monitoring | Application Insights |

---

---

## Quick start

### Prerequisites
- Node.js 20+
- Azure Functions Core Tools 4.x
- Azure subscription (for Cosmos DB, Functions, AI Search)

### Local development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp local.settings.json.example local.settings.json
# Edit local.settings.json with your API keys

# 3. Start backend (Azure Functions)
func host start

# 4. Start frontend (optional, for Web UI)
cd campus-ai-web && npm run dev
```

### Deploy to Azure

```bash
# Option 1: Using the deployment script
./deploy-functions.sh

# Option 2: Push to main branch (triggers GitHub Actions)
git push origin main
```

---

## Project structure

```
qq-bot-aris-clean/
├── src/
│   ├── functions/
│   │   ├── schoolBot.js        # Main bot logic (7000+ lines of evolution)
│   │   └── dailyClassReminder.js
│   └── common/
│       └── safety.js           # Deterministic safety rules
├── services/                   # Modular services
│   ├── hybridSearch.js
│   ├── scheduleService.js
│   └── visionService.js
├── campus-ai-web/              # Next.js frontend
├── docs/                       # Design evolution docs
└── .github/workflows/          # CI/CD pipelines
```

---

## Documentation

| Document | Purpose |
|----------|---------|
| [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) | Why this project exists, design journey, and core beliefs |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Technical architecture, multi-layer safety system, and implementation details |
| [docs/P0-INTEGRATION-GUIDE.md](docs/P0-INTEGRATION-GUIDE.md) | Integration guide for production deployment |

---

## Contributing

This project is a **learning record** and **responsibility experiment**. Contributions are welcome, but please read [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) first to understand the core principles.

---

## Design Philosophy

This project includes a design philosophy document (`DESIGN_PHILOSOPHY.md`)
which defines the responsibility boundaries and safety assumptions of the system.

Any derivative work that removes or materially alters this document
**without clear attribution** is considered a misrepresentation of the original design intent.

## License

Apache License 2.0 (Apache-2.0). See `LICENSE` and `NOTICE`.

---

## Acknowledgments

To everyone who was ever misled by AI-generated fake schedules: you taught me that **"being cute" is not a liability shield**.

To anyone building AI systems: ask not "how to make it smarter", but **"what harm it causes when it's not smart enough"**.

---

*Built by Ziheng Liu*  
*From "making her more human" to "making the system less harmful"*
