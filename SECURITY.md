# Security Policy

## Reporting a Vulnerability

Please report security issues privately:

- Open a private security advisory if available.
- Or contact maintainers directly with reproduction steps and impact.

Do not disclose public proof-of-concept until a fix is prepared.

## Secret Handling

- Do not commit any tokens, keys, credentials, or connection strings.
- Use `local.settings.json` for local-only secrets.
- Use cloud secret management for production.
- Production should enable ingress protection for `/api/schoolbot`:
  - `ARIS_REQUIRE_INGRESS_AUTH=true`
  - Configure `ARIS_INGRESS_SHARED_KEY` and/or `ARIS_INGRESS_SIGNATURE_SECRET`
- Refusal policy rollout should use percentage gating (`ARIS_REFUSAL_POLICY_PERCENT`) to reduce false-positive blocking risk.
- Computer-use agent endpoints (`/api/v2/computer-use/agent/*`) require `ARIS_CU_AGENT_TOKEN`.
- For host mode desktop automation:
  - Keep `ARIS_CU_CONFIRM_MODE=periodic` (default) unless you explicitly accept full-auto risk.
  - Rotate `ARIS_CU_AGENT_TOKEN` regularly.
  - Treat screenshots as sensitive data and avoid logging raw pixels into public audit streams.
- In `server` profile, keep `ARIS_CU_ENABLED=false` unless a trusted remote executor path is configured.

## Supported Scope

Security reports are prioritized for:

- `src/functions/**`
- `src/v2/**`
- `services/**`
- deployment scripts in repository root and `scripts/`
