# Contributing

## Development Setup

```bash
npm ci
cp local.settings.example.json local.settings.json
npm run verify:runtime
npm run start
```

## Coding Guidelines

- Keep backend logic modular under `src/functions/schoolbot/**`.
- Avoid hardcoded credentials or deployment-sensitive defaults.
- Prefer dependency injection for external APIs.

## Tests

Run backend tests before submitting PR:

```bash
npm run test:schoolbot
```

## Pull Request Checklist

- [ ] No secrets in diff.
- [ ] `npm run verify:runtime` passes.
- [ ] `npm run test:schoolbot` passes.
- [ ] Documentation updated if behavior/config changed.
