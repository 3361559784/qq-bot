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

## Worker

- `ARIS_WORKER_ENABLED` (default: `true`)
- `ARIS_WORKER_POLL_MS` (default: `30000`)
- `ARIS_REMINDER_CRON` (default: `0 7 * * *`)

## LLM / Model

- `GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_MODELS_TOKEN`
- `OPENAI_API_KEY`

## Computer Use

- `ARIS_RUNTIME_PROFILE` (`host|server`)
- `ARIS_CU_ENABLED`
- `ARIS_CU_TRANSPORT` (`mcp_stdio|http_agent|hybrid`)
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
- `ARIS_CU_OPENAI_BASE_URL`

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
