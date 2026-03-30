# v2 Migration Design

## Scope
- Migrate API usage from legacy `/api/schoolbot` to `/api/v2/*` endpoints.
- Keep v1 in read-only compatibility mode during migration window.

## New Containers
- ConversationsV2
- MemoryV2
- SkillsV2
- TasksV2
- AuditV2

## Data Migration Rules
1. Read legacy `history` entries.
2. Filter refusal-template pollution patterns.
3. Convert to:
   - `summary` memory records (session-level)
   - `fact/preference` user records (stable data only)
4. Set TTL for long-term memory entries.

## Write Path Strategy
- v2 endpoints are the only write path.
- v1 remains readable during migration window.
- Every write includes `request_id` for idempotency and rollback tracing.

## Rollback
- Keep backup snapshots for all v2 containers before cutover.
- On rollback:
  1. disable v2 write traffic;
  2. restore latest snapshots;
  3. redirect clients back to v1 read path.

## Acceptance Checks
- API contract parity against `docs/v2/openapi.yaml`.
- Memory pollution rate below baseline.
- Refusal reasons always contain `reason_code`.
- Task execution success and retry behavior verified.
