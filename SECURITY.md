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

## Supported Scope

Security reports are prioritized for:

- `src/functions/**`
- `src/v2/**`
- `services/**`
- deployment scripts in repository root and `scripts/`
