# Security Policy

## Reporting

Report vulnerabilities privately to maintainers with reproduction steps and impact.

## Production Baseline

- Keep `ARIS_AUTH_DISABLED=false`.
- Set strong values for:
  - `ARIS_AUTH_KEY`
  - `ARIS_AUTH_SIGNATURE_SECRET`
- Enforce secret management via environment/secret manager, never commit secrets.

## Computer-use Controls

- `ARIS_CU_AGENT_TOKEN` is required for `/api/v3/computer-use/agent/*`.
- Keep `ARIS_CU_CONFIRM_MODE=periodic` unless full-auto risk is explicitly accepted.
- Keep relay PoC disabled in production unless consciously forced:
  - `ARIS_CU_RELAY_ENABLE_DEV=false`
  - `ARIS_CU_RELAY_FORCE_PROD=false`

## Data Security

- PostgreSQL should run with least-privilege credentials.
- Restrict network exposure for DB and agent endpoints.
- Treat screenshots and audit payloads as sensitive data.
