# SchoolBot Backend (Standalone)

Fastify + PostgreSQL self-hosted backend for SchoolBot.

基于 Fastify + PostgreSQL 的 SchoolBot 独立后端（已脱离 Azure 运行时与存储依赖）。

## Architecture

- API runtime: `src/standalone/server.js`
- API routes: `src/standalone/routes/v3.js`
- Core conversation/skills: `src/v2/**`
- Storage adapter: `src/v2/services/storage.js` -> PostgreSQL / memory fallback
- PostgreSQL client: `src/storage/pg/client.js`
- Worker scheduler: `src/worker/index.js`
- Computer-use MCP server: `local/mcp-computer-use-server/`

## API

Base path: `/api/v3`

- `POST /chat`
- `POST /chat/stream`
- `GET /skills`
- `POST /skills/install`
- `DELETE /skills/:name`
- `POST /memory`
- `GET /memory/search`
- `GET /tasks`
- `POST /tasks`
- `PATCH /tasks/:id`
- `DELETE /tasks/:id`
- `POST /computer-use/jobs`
- `GET /computer-use/jobs/:id`
- `POST /computer-use/jobs/:id/confirm`
- `POST /computer-use/jobs/:id/cancel`
- `POST /computer-use/agent/poll`
- `POST /computer-use/agent/report`
- `POST /computer-use/agent/heartbeat`

Health:

- `GET /healthz`
- `GET /readyz`

## Auth (default enabled)

Headers:

- `x-aris-key`
- `x-aris-timestamp` (unix seconds)
- `x-aris-signature` (`sha256=<hex>`)

Canonical string:

```text
{timestamp}\n{METHOD}\n{ROUTE_PATH}
```

## Quick Start

1. Install dependencies

```bash
npm ci
```

2. Copy env

```bash
cp .env.example .env
```

3. Start PostgreSQL and services

```bash
docker compose up -d postgres
npm run migrate
npm run start:api
npm run start:worker
```

Or one command:

```bash
npm run dev:compose
```

## Tests

```bash
npm run test:schoolbot
```

## Migration

Schema migration:

```bash
npm run migrate
```

Cosmos to PostgreSQL migration tool (optional):

```bash
npm run migrate:cosmos
```

If `@azure/cosmos` is missing, install it temporarily for migration only.

## Notes

- This repo is backend-only for now; no built-in frontend shell in P0.
- `computer-use` defaults to GitHub Models-compatible planner chain:
  - `ARIS_CU_PROVIDER_MODE=auto`
  - `ARIS_CU_PLANNER_MODELS=openai/gpt-5-nano,openai/gpt-4.1-mini,openai/gpt-4o-mini`
  - `ARIS_CU_OPENAI_BASE_URL=https://models.github.ai/inference`
- Recommended key is `GITHUB_MODELS_TOKEN` (also supports `GITHUB_TOKEN` / `GH_TOKEN`).
- `computer-use` is host-first. In container mode, prefer `ARIS_CU_TRANSPORT=http_agent` and run local agent on host.
- Legacy Azure docs moved to `docs/archive/azure.md`.
