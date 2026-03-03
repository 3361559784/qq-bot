# Campus Copilot Backend / 校园 Copilot 后端

Backend service for a campus assistant built on Azure Functions.

基于 Azure Functions 的校园助手后端服务。

## Project Scope / 项目范围

- This repository currently focuses on **backend only**.
- Frontend is intentionally out of scope in this repo state.

- 当前仓库仅维护**后端**。
- 前端当前不在本仓库维护范围内。

## Architecture / 架构

- Runtime: Node.js + Azure Functions v4
- Entry: `src/index.js`
- Main bot endpoint: `src/functions/schoolBot.js`
- Main handler implementation: `src/functions/schoolbot/http/handler.js`
- Services: `services/`
- v2 APIs: `src/functions/v2Api.js` + `src/v2/`
- Local computer-use agent (macOS): `local/computer-use-agent/`
- Local MCP stdio server (macOS): `local/mcp-computer-use-server/`

Core modules after refactor:

- Runtime config: `src/functions/schoolbot/config/runtime.js`
- Thin HTTP orchestrator: `src/functions/schoolbot/http/handler.js`
- Legacy engine fallback: `src/functions/schoolbot/runtime/legacyEngine.js`
- v2 engine bridge: `src/functions/schoolbot/runtime/v2Engine.js`
- Engine selector (gray/shadow): `src/functions/schoolbot/runtime/engineSelector.js`
- Unified refusal policy: `src/common/refusalPolicy.js`
- Policy gates: `src/functions/schoolbot/policy/gates.js`
- Request parsing: `src/functions/schoolbot/http/requestParser.js`
- Non-chat event routing: `src/functions/schoolbot/http/eventRouter.js`
- Response adapter: `src/functions/schoolbot/http/responseAdapter.js`
- Ingress auth guard: `src/functions/schoolbot/http/authGuard.js`
- Poke subsystem: `src/functions/schoolbot/features/poke.js`
- Media helpers: `src/functions/schoolbot/features/media.js`
- Public bridge API: `src/functions/schoolbot/publicApi.js`
- Type contracts: `src/functions/schoolbot/contracts.ts`
- Computer-use queue/service: `src/v2/services/computerUseQueue.js` + `src/v2/services/computerUseService.js`
- Computer-use MCP client bridge: `src/v2/services/computerUseMcpClient.js`
- Computer-use intent matcher: `src/v2/services/computerUseIntent.js`

## Quick Start / 本地启动

### Prerequisites / 前置依赖

- Node.js 20+
- Azure Functions Core Tools 4.x

### Install / 安装

```bash
npm ci
```

### Configure / 配置

1. Copy `local.settings.example.json` to `local.settings.json`.
2. Fill required env values.

1. 复制 `local.settings.example.json` 为 `local.settings.json`。
2. 填写必需环境变量。

See full env reference: `docs/env.md`.

### Smoke Check / 冒烟检查

```bash
npm run verify:runtime
```

### Run / 启动

```bash
npm run start
```

## API Routes / 接口路由

Primary routes:

- `POST /api/schoolbot`
- `POST /api/ocrCourse`
- `POST /api/scrapeChaoxing`
- `POST /api/v2/messages`
- `POST /api/v2/messages/stream`
- `GET /api/v2/skills`
- `POST /api/v2/skills/install`
- `DELETE /api/v2/skills/{name}`
- `POST /api/v2/memory`
- `GET /api/v2/memory/search`
- `GET /api/v2/tasks`
- `POST /api/v2/tasks`
- `PATCH /api/v2/tasks/{id}`
- `DELETE /api/v2/tasks/{id}`
- `POST /api/v2/computer-use/jobs`
- `GET /api/v2/computer-use/jobs/{id}`
- `POST /api/v2/computer-use/jobs/{id}/confirm`
- `POST /api/v2/computer-use/jobs/{id}/cancel`
- `POST /api/v2/computer-use/agent/poll`
- `POST /api/v2/computer-use/agent/report`
- `POST /api/v2/computer-use/agent/heartbeat`

Computer-use transport mode:

- `mcp_stdio` (P0 default): BYOK + MCP stdio
- `http_agent`: legacy HTTP polling agent
- `hybrid`: try MCP first, fallback HTTP agent

## Security / 安全

- Never commit secrets to git.
- Use env vars for all credentials.
- Hardcoded deployment-sensitive GPT-SoVITS values are removed.
- `_debug` response metadata is disabled by default (`ARIS_DEBUG_RESPONSE=false`).
- Engine defaults: `ARIS_SCHOOLBOT_ENGINE=legacy`, `ARIS_SCHOOLBOT_V2_PERCENT=0`.
- Optional ingress auth is supported by `ARIS_REQUIRE_INGRESS_AUTH`.
- Refusal policy defaults to relaxed mode with minimal hard-block categories.
- Computer-use supports `host|server` runtime profile:
  - `host`: local agent polling is enabled by default.
  - `server`: disabled by default unless remote endpoint is configured.
- P0 default transport is `mcp_stdio` with OpenAI BYOK.
- Experimental fallback provider `chatgpt_plus_relay_poc` is dev/test only by default and blocked in production unless explicitly forced.
- Agent routes require `ARIS_CU_AGENT_TOKEN`.
- Default confirmation policy for computer-use is `periodic` with 5-step cadence.

- 严禁把密钥提交到 git。
- 所有凭据必须使用环境变量。
- GPT-SoVITS 的敏感硬编码默认值已移除。
- 响应中的 `_debug` 默认关闭（`ARIS_DEBUG_RESPONSE=false`）。
- 运行默认是 legacy 引擎（`ARIS_SCHOOLBOT_ENGINE=legacy`，`ARIS_SCHOOLBOT_V2_PERCENT=0`）。
- 支持可配置入口鉴权（`ARIS_REQUIRE_INGRESS_AUTH`）。
- 拒绝策略默认是放宽版（最小硬拒绝集合）。

Please read `SECURITY.md` for vulnerability reporting.

## Deployment / 部署

### Local Azure CLI deploy / 本地脚本部署

```bash
./deploy-functions.sh
```

### GitHub Actions deploy / GitHub Actions 部署

- Workflow: `.github/workflows/main_school-bot.yml`
- Trigger: push to `main` with backend file changes.

## Tests / 测试

```bash
npm run test:schoolbot
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
