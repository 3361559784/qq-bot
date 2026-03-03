# Environment Variables (Standalone)

## Core Runtime

- `ARIS_HTTP_PORT` (default: `3000`)
- `ARIS_HTTP_HOST` (default: `0.0.0.0`)
- `DATABASE_URL` (required for PostgreSQL mode)
- `PG_SSL` (`true|false`, optional)

If `DATABASE_URL` is not set, storage falls back to in-memory mode.

## API Auth (default enabled)

- `ARIS_AUTH_DISABLED` (`true|false`, default: `false`)
- `ARIS_AUTH_KEY` (required in production)
- `ARIS_AUTH_SIGNATURE_SECRET` (required in production)
- `ARIS_AUTH_MAX_SKEW_SEC` (default: `300`)

## Frontend Proxy (Next.js)

- `ARIS_API_INTERNAL_BASE_URL` (default: `http://api:3000`)
- `ARIS_PROXY_TIMEOUT_MS` (default: `30000`)
- `ARIS_AUTH_KEY` (required on frontend server for proxy signing)
- `ARIS_AUTH_SIGNATURE_SECRET` (required on frontend server for proxy signing)

## Worker

- `ARIS_WORKER_ENABLED` (default: `true`)
- `ARIS_WORKER_POLL_MS` (default: `30000`)
- `ARIS_REMINDER_CRON` (default: `0 7 * * *`)

## LLM / Model

- `GITHUB_MODELS_TOKEN` (recommended)
- `GITHUB_TOKEN` / `GH_TOKEN` (compat)
- `OPENAI_API_KEY`

## Computer Use

- `ARIS_RUNTIME_PROFILE` (`host|server`)
- `ARIS_CU_ENABLED`
- `ARIS_CU_TRANSPORT` (`mcp_stdio|http_agent|hybrid`)
- `ARIS_CU_PROVIDER_MODE` (`github_models|openai_compatible|auto`, default `auto`)
- `ARIS_CU_TRIGGER_MODE` (`explicit|auto|both`)
- `ARIS_CU_CONFIRM_MODE` (`periodic|always|never`)
- `ARIS_CU_CONFIRM_EVERY_STEPS`
- `ARIS_CU_STEP_MAX_RETRY`
- `ARIS_CU_MAX_STEPS`
- `ARIS_CU_SYNC_WAIT_MS`
- `ARIS_CU_LEASE_TTL_SEC`
- `ARIS_CU_AGENT_TOKEN`
- `ARIS_CU_MCP_SERVER_CMD`
- `ARIS_CU_MCP_SERVER_CWD`
- `ARIS_CU_MCP_TIMEOUT_MS`
- `ARIS_CU_OPENAI_BASE_URL` (default: `https://models.github.ai/inference`)
- `ARIS_CU_PLANNER_MODELS` (default: `openai/gpt-5-nano,openai/gpt-4.1-mini,openai/gpt-4o-mini`)
- `ARIS_CU_PLANNER_MODEL` (legacy single-model fallback; used only when `ARIS_CU_PLANNER_MODELS` is empty)

Relay PoC:

- `ARIS_CU_RELAY_PROVIDER`
- `ARIS_CU_RELAY_ENABLE_DEV`
- `ARIS_CU_RELAY_MAX_RETRY`
- `ARIS_CU_RELAY_TIMEOUT_MS`
- `ARIS_CU_RELAY_BROWSER_PROFILE_DIR`
- `ARIS_CU_RELAY_HEADLESS`
- `ARIS_CU_RELAY_FORCE_PROD`

## Integrations

- `NAPCAT_API_URL`
- `NAPCAT_TOKEN`
- `BOT_QQ_ID`
- `SENIVERSE_API_KEY`
- `SERPAPI_KEY`
- `SCRAPER_ENDPOINT`

## GPT-SoVITS

- `ARIS_GPTSOVITS_API_URL`
- `ARIS_GPTSOVITS_GPT_WEIGHTS`
- `ARIS_GPTSOVITS_SOVITS_WEIGHTS`
- `ARIS_GPTSOVITS_REF_AUDIO_PATH`
- `ARIS_GPTSOVITS_REF_PROMPT_TEXT`
- `ARIS_GPTSOVITS_REF_PROMPT_LANG`
