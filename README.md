# Alice / Campus Copilot

Safety-first campus AI assistant.

## Runtime architecture

- Backend: Azure Functions (`/Users/liuziheng/qq-bot-aris-clean/src`, `/Users/liuziheng/qq-bot-aris-clean/services`)
- Frontend: Next.js (`/Users/liuziheng/qq-bot-aris-clean/campus-ai-web`)

Main backend entry:
- `/Users/liuziheng/qq-bot-aris-clean/src/index.js`

Main HTTP function:
- `/Users/liuziheng/qq-bot-aris-clean/src/functions/schoolBot.js`

## Local run

Prerequisites:
- Node.js 20+
- Azure Functions Core Tools 4.x

Backend:

```bash
cd /Users/liuziheng/qq-bot-aris-clean
npm install
npm run verify:runtime
npm run start
```

Frontend:

```bash
cd /Users/liuziheng/qq-bot-aris-clean/campus-ai-web
npm install
npm run dev
```

## Deploy

```bash
cd /Users/liuziheng/qq-bot-aris-clean
./deploy-functions.sh
```

or push to `main` and let GitHub Actions deploy.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
