# Environment Variables

## Required

- `GITHUB_TOKEN`: LLM and vision model access token.
- `COSMOS_DB_STRING`: Cosmos DB connection string.

## Recommended

- `ARIS_MOCK_CHAT`: `true|false`, local fallback mode.
- `ARIS_PIPELINE_ENABLED`: enable/disable new pipeline.
- `ARIS_DEBUG_RESPONSE`: include `meta._debug` when `true`.

## SchoolBot Engine Routing

- `ARIS_SCHOOLBOT_ENGINE`: `legacy|v2|shadow` (default: `legacy`)
- `ARIS_SCHOOLBOT_V2_PERCENT`: `0..100` (default: `0`)
- `ARIS_RUNTIME_PROFILE`: `host|server` (default: `host`)

## Computer Use (Host-first)

- `ARIS_CU_ENABLED`: `true|false` (default: `true` on `host`, `false` on `server`)
- `ARIS_CU_TRIGGER_MODE`: `explicit|auto|both` (default: `both`)
- `ARIS_CU_CONFIRM_MODE`: `periodic|always|never` (default: `periodic`)
- `ARIS_CU_CONFIRM_EVERY_STEPS`: confirm interval (default: `5`)
- `ARIS_CU_STEP_MAX_RETRY`: max retries per step (default: `2`)
- `ARIS_CU_MAX_STEPS`: max steps per job (default: `30`)
- `ARIS_CU_SYNC_WAIT_MS`: sync wait for skill response (default: `18000`)
- `ARIS_CU_LEASE_TTL_SEC`: job lease TTL for agent (default: `45`)
- `ARIS_CU_AGENT_TOKEN`: required token for `/api/v2/computer-use/agent/*`
- `ARIS_CU_REMOTE_ENDPOINT`: optional remote executor endpoint (for `server` profile)
- `ARIS_CU_PLANNER_MODEL`: planner model id (default: `gpt-4o-mini`)
- `OPENAI_API_KEY`: OpenAI API key for visual planner

## Ingress Auth (Optional, recommended in production)

- `ARIS_REQUIRE_INGRESS_AUTH`: `true|false` (default: `false`)
- `ARIS_INGRESS_SHARED_KEY`: shared secret header key
- `ARIS_INGRESS_SIGNATURE_SECRET`: HMAC-SHA256 signature secret
- `ARIS_INGRESS_SIGNATURE_SKEW_SEC`: max timestamp skew in seconds (default: `300`)
- Header contract:
  - Shared key: `x-aris-key` (or `Authorization: Bearer <key>`)
  - Signature: `x-aris-timestamp` + `x-aris-signature` (`sha256=<hex>`)

## Refusal Policy (Experience-First)

- `ARIS_REFUSAL_POLICY_VERSION` (default: `relaxed_v1`)
- `ARIS_REFUSAL_POLICY_PERCENT` (`0..100`, default: `0`)
- `ARIS_REFUSAL_MODEL_ENABLED` (`true|false`, default: `true`)
- `ARIS_REFUSAL_MODEL_HARD_MIN_CONF` (default: `0.85`)
- `ARIS_REFUSAL_CLARIFY_MAX_ROUNDS` (default: `1`)
- `ARIS_REFUSAL_DELEGATED_MODE` (`degrade|clarify`, default: `degrade`)
- `ARIS_REFUSAL_HARD_BLOCK_SCOPE` (`minimal|extended`, default: `minimal`)

## Search / Weather

- `SERPAPI_KEY`
- `SENIVERSE_API_KEY`

## QQ / Bot Integration

- `NAPCAT_API_URL`
- `NAPCAT_TOKEN`
- `BOT_QQ_ID`

## GPT-SoVITS

- `ARIS_GPTSOVITS_API_URL`
- `ARIS_GPTSOVITS_GPT_WEIGHTS`
- `ARIS_GPTSOVITS_SOVITS_WEIGHTS`
- `ARIS_GPTSOVITS_REF_AUDIO_PATH`
- `ARIS_GPTSOVITS_REF_PROMPT_TEXT`
- `ARIS_GPTSOVITS_REF_PROMPT_LANG`

## Feature Flags (Examples)

- `ARIS_DISABLE_POKE`
- `ARIS_INTENT_ROUTER`
- `ARIS_DEV_BACKDOOR`

## v2 Storage Tuning

- `V2_DB_NAME`
- `V2_CONVERSATIONS_CONTAINER`
- `V2_MEMORY_CONTAINER`
- `V2_SKILLS_CONTAINER`
- `V2_TASKS_CONTAINER`
- `V2_AUDIT_CONTAINER`
- `V2_COMPUTER_USE_JOBS_CONTAINER`
