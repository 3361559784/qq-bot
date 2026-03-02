# Environment Variables

## Required

- `GITHUB_TOKEN`: LLM and vision model access token.
- `COSMOS_DB_STRING`: Cosmos DB connection string.

## Recommended

- `ARIS_MOCK_CHAT`: `true|false`, local fallback mode.
- `ARIS_PIPELINE_ENABLED`: enable/disable new pipeline.
- `ARIS_DEBUG_RESPONSE`: include `meta._debug` when `true`.

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
